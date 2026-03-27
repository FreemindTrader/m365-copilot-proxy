import { ChatCompletionRequest } from "./schemas.js";
import { getToken } from "./auth.js";
import { getOrCreateAgent } from "./agent.js";
import { formatMessages, parseToolCalls, getMessageContent, TOOL_CALL_FENCE, TOOL_CALL_FENCE_CLOSE } from "./tools.js";
import { CopilotSession } from "./session.js";
import { createLogger } from "./log.js";
import type { z } from "zod/v4";

const log = createLogger("handler");

type ChatBody = z.infer<typeof ChatCompletionRequest>;
type ParsedMessage = ChatBody["messages"][number];

// --- HandlerContext: holds session state across requests ---

export class HandlerContext {
  activeSession: CopilotSession | null = null;
  sentMessageCount = 0;
  cachedAgentId: string | null | undefined = undefined;
  /** Hash of the first user message — used to detect new conversations */
  private firstUserMessageHash: string | null = null;

  /**
   * Check if this request is a new conversation or a continuation.
   * New conversation if:
   *   - messages array is shorter than what we've sent (user started fresh)
   *   - first user message changed (different conversation)
   */
  shouldResetSession(messages: ParsedMessage[]): boolean {
    if (!this.activeSession) return false; // no session to reset

    // Messages shrunk — definitely a new conversation
    if (messages.length < this.sentMessageCount) {
      log.info(`Conversation reset: messages shrunk (${messages.length} < ${this.sentMessageCount})`);
      return true;
    }

    // Check if the first user message changed
    const firstUser = messages.find(m => m.role === "user");
    const hash = firstUser ? simpleHash(getMessageContent(firstUser)) : null;
    if (this.firstUserMessageHash !== null && hash !== this.firstUserMessageHash) {
      log.info("Conversation reset: first user message changed");
      return true;
    }

    return false;
  }

  /** Update tracking after a successful request */
  trackMessages(messages: ParsedMessage[]) {
    this.sentMessageCount = messages.length;
    if (this.firstUserMessageHash === null) {
      const firstUser = messages.find(m => m.role === "user");
      this.firstUserMessageHash = firstUser ? simpleHash(getMessageContent(firstUser)) : null;
    }
  }

  /** Reset session state for a new conversation */
  reset() {
    this.activeSession = null;
    this.sentMessageCount = 0;
    this.firstUserMessageHash = null;
    // Keep cachedAgentId — agent persists across conversations
  }
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return String(hash);
}

/** Create a new handler context for independent session tracking */
export function createHandlerContext(): HandlerContext {
  return new HandlerContext();
}

// Default module-level context (used by opencode-plugin for backward compat)
const defaultContext = new HandlerContext();

// --- Message formatting ---

/**
 * Format only the new messages since the last turn.
 * No system prompt, no tool definitions, no few-shot examples —
 * M365 already has those from the first turn.
 */
function formatDeltaMessages(messages: ParsedMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      const calls = m.tool_calls.map((tc) => {
        const args = typeof tc.function.arguments === "string"
          ? tc.function.arguments
          : JSON.stringify(tc.function.arguments);
        return `${TOOL_CALL_FENCE}\n{"name": "${tc.function.name}", "arguments": ${args}}\n${TOOL_CALL_FENCE_CLOSE}`;
      }).join("\n");
      const content = getMessageContent(m);
      parts.push(`[assistant]\n${content ? content + "\n" : ""}${calls}`);
    } else if (m.role === "tool") {
      const name = m.name || "unknown";
      const callId = m.tool_call_id || "?";
      parts.push(`[tool result for ${name} (${callId})]\n${getMessageContent(m)}`);
    } else if (m.role === "system") {
      // Skip system messages on follow-up turns
    } else {
      parts.push(`[${m.role}]\n${getMessageContent(m)}`);
    }
  }
  return parts.join("\n\n");
}

// --- Main handler ---

export interface HandlerOptions {
  /** Pre-resolved auth token. If not provided, getToken() is called. */
  getToken?: () => Promise<string>;
  /** Whether to attempt agent resolution. Default: true. */
  useAgent?: boolean;
  /** Session context. Default: module-level shared context. */
  context?: HandlerContext;
}

/**
 * Handle a chat completion request in-process (no HTTP).
 * Uses a persistent CopilotSession so all turns share the same
 * M365 conversation (saves quota, enables server-side context).
 *
 * First turn: sends full prompt (system + tools + few-shot + messages).
 * Follow-up turns: sends only new messages (tool results + user message).
 * New conversation detected: resets session automatically.
 */
export async function handleChatCompletion(
  body: ChatBody,
  options: HandlerOptions = {},
): Promise<Response> {
  const resolveToken = options.getToken ?? getToken;
  const useAgent = options.useAgent !== false;
  const ctx = options.context ?? defaultContext;

  let token: string;
  try {
    token = await resolveToken();
  } catch (err: any) {
    return jsonResponse(401, { error: { message: err.message, type: "auth_error" } });
  }

  const hasTools = body.tools && body.tools.length > 0 && body.tool_choice !== "none";
  const model = body.model;

  // Resolve agent ID lazily (shared across conversations)
  if (useAgent && ctx.cachedAgentId === undefined) {
    try {
      ctx.cachedAgentId = await getOrCreateAgent();
      if (ctx.cachedAgentId) log.info(`Using agent: ${ctx.cachedAgentId}`);
      else log.info("No agent available, using prompt injection only");
    } catch {
      ctx.cachedAgentId = null;
    }
  }

  // Detect new conversation and reset if needed
  if (ctx.shouldResetSession(body.messages)) {
    ctx.reset();
  }

  // Create session if needed
  const isFirstTurn = !ctx.activeSession;
  if (!ctx.activeSession) {
    ctx.activeSession = new CopilotSession(ctx.cachedAgentId ? { agentId: ctx.cachedAgentId } : undefined);
  }

  // Format message: full prompt on first turn, delta on follow-ups
  let text: string;
  if (isFirstTurn || ctx.sentMessageCount === 0) {
    text = formatMessages(body.messages, body.tools, body.tool_choice);
    log.info(`Chat completion: model=${model}, stream=${body.stream}, messages=${body.messages.length}, turn=${ctx.activeSession.turnCount}, mode=full, agent=${!!ctx.cachedAgentId}`);
  } else {
    const newMessages = body.messages.slice(ctx.sentMessageCount);
    if (newMessages.length > 0) {
      text = formatDeltaMessages(newMessages);
      log.info(`Chat completion: model=${model}, stream=${body.stream}, messages=${body.messages.length}, new=${newMessages.length}, turn=${ctx.activeSession.turnCount}, mode=delta, agent=${!!ctx.cachedAgentId}`);
    } else {
      text = formatMessages(body.messages, body.tools, body.tool_choice);
      log.info(`Chat completion: model=${model}, stream=${body.stream}, messages=${body.messages.length}, turn=${ctx.activeSession.turnCount}, mode=full-retry, agent=${!!ctx.cachedAgentId}`);
    }
  }

  ctx.trackMessages(body.messages);
  log.debug("Formatted prompt:", text.slice(0, 1000));

  const completionId = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  let copilotStream;
  try {
    copilotStream = await ctx.activeSession.chat(token, text, model);
  } catch (err: any) {
    // Session might be stale — reset and retry with full prompt
    log.info("Session error, resetting:", err.message);
    ctx.reset();
    ctx.activeSession = new CopilotSession(ctx.cachedAgentId ? { agentId: ctx.cachedAgentId } : undefined);
    const fullText = formatMessages(body.messages, body.tools, body.tool_choice);
    try {
      copilotStream = await ctx.activeSession.chat(token, fullText, model);
      ctx.trackMessages(body.messages);
    } catch (retryErr: any) {
      ctx.reset();
      return jsonResponse(502, { error: { message: retryErr.message, type: "upstream_error" } });
    }
  }

  // When tools are present, buffer full response to detect tool calls
  if (hasTools) {
    let fullText = "";
    try {
      for await (const delta of copilotStream) fullText += delta;
      if (copilotStream.fullText && copilotStream.fullText.length > fullText.length) {
        fullText = copilotStream.fullText;
      }

      if (!copilotStream.hasContent && fullText.length === 0) {
        return rateLimitResponse(copilotStream.throttle);
      }
    } catch (err: any) {
      return jsonResponse(502, { error: { message: err.message, type: "upstream_error" } });
    }

    log.debug("Raw response (tool mode):", fullText.slice(0, 1000));
    const parsed = parseToolCalls(fullText);
    log.info(`Parse result: hasToolCalls=${parsed.hasToolCalls}, count=${parsed.toolCalls.length}`);

    // Handle "reply" tool calls — convert to plain text
    if (parsed.hasToolCalls) {
      const replyCall = parsed.toolCalls.find(tc => tc.function.name === "reply");
      const realToolCalls = parsed.toolCalls.filter(tc => tc.function.name !== "reply");

      if (replyCall && realToolCalls.length === 0) {
        let replyText: string;
        try {
          const args = JSON.parse(replyCall.function.arguments);
          replyText = args.text || args.message || args.content || fullText;
        } catch {
          replyText = fullText;
        }
        log.info("Reply tool detected, converting to text response");
        if (body.stream) {
          return sseResponse(streamText(completionId, created, model, replyText));
        } else {
          return jsonResponse(200, {
            id: completionId, object: "chat.completion", created, model,
            choices: [{ index: 0, message: { role: "assistant", content: replyText }, finish_reason: "stop" }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          });
        }
      }

      if (realToolCalls.length > 0) {
        parsed.toolCalls = realToolCalls;
      }
    }

    if (parsed.hasToolCalls && parsed.toolCalls.length > 0) {
      if (body.stream) {
        return sseResponse(streamToolCalls(completionId, created, model, parsed));
      } else {
        return jsonResponse(200, {
          id: completionId, object: "chat.completion", created, model,
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: parsed.textContent,
              tool_calls: parsed.toolCalls,
            },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      }
    } else {
      if (body.stream) {
        return sseResponse(streamText(completionId, created, model, fullText));
      } else {
        return jsonResponse(200, {
          id: completionId, object: "chat.completion", created, model,
          choices: [{ index: 0, message: { role: "assistant", content: fullText }, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      }
    }
  } else if (body.stream) {
    // No tools — streaming passthrough
    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        let hasAnything = false;

        try {
          for await (const delta of copilotStream) {
            if (!hasAnything) {
              controller.enqueue(enc.encode(`data: ${JSON.stringify({
                id: completionId, object: "chat.completion.chunk", created, model,
                choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
              })}\n\n`));
              hasAnything = true;
            }
            controller.enqueue(enc.encode(`data: ${JSON.stringify({
              id: completionId, object: "chat.completion.chunk", created, model,
              choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
            })}\n\n`));
          }
        } catch {}

        if (!hasAnything && !copilotStream.hasContent) {
          const msg = rateLimitMessage(copilotStream.throttle);
          controller.enqueue(enc.encode(`data: ${JSON.stringify({
            id: completionId, object: "chat.completion.chunk", created, model,
            choices: [{ index: 0, delta: { content: msg }, finish_reason: null }],
          })}\n\n`));
        }

        if (hasAnything || !copilotStream.hasContent) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify({
            id: completionId, object: "chat.completion.chunk", created, model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })}\n\n`));
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
        }
        controller.close();
      },
    });

    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  } else {
    // No tools, no streaming
    let fullText = "";
    try {
      for await (const delta of copilotStream) fullText += delta;
      if (copilotStream.fullText && copilotStream.fullText.length > fullText.length) {
        fullText = copilotStream.fullText;
      }
    } catch (err: any) {
      return jsonResponse(502, { error: { message: err.message, type: "upstream_error" } });
    }

    if (!copilotStream.hasContent && fullText.length === 0) {
      return rateLimitResponse(copilotStream.throttle);
    }

    return jsonResponse(200, {
      id: completionId, object: "chat.completion", created, model,
      choices: [{ index: 0, message: { role: "assistant", content: fullText }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }
}

// --- Helpers ---

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseResponse(stream: ReadableStream): Response {
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

function rateLimitMessage(throttle: { current: number; max: number } | null): string {
  return throttle
    ? `M365 Copilot rate limited (${throttle.current}/${throttle.max} messages used). Please wait and try again.`
    : "M365 Copilot returned an empty response. You may be rate limited. Please wait and try again.";
}

function rateLimitResponse(throttle: { current: number; max: number } | null): Response {
  return jsonResponse(429, { error: { message: rateLimitMessage(throttle), type: "rate_limit_error" } });
}

function streamToolCalls(
  completionId: string, created: number, model: string,
  parsed: ReturnType<typeof parseToolCalls>,
): ReadableStream {
  return new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();

      controller.enqueue(enc.encode(`data: ${JSON.stringify({
        id: completionId, object: "chat.completion.chunk", created, model,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      })}\n\n`));

      for (let i = 0; i < parsed.toolCalls.length; i++) {
        const tc = parsed.toolCalls[i];
        controller.enqueue(enc.encode(`data: ${JSON.stringify({
          id: completionId, object: "chat.completion.chunk", created, model,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: i, id: tc.id, type: "function",
                function: { name: tc.function.name, arguments: tc.function.arguments },
              }],
            },
            finish_reason: null,
          }],
        })}\n\n`));
      }

      controller.enqueue(enc.encode(`data: ${JSON.stringify({
        id: completionId, object: "chat.completion.chunk", created, model,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      })}\n\n`));
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

function streamText(
  completionId: string, created: number, model: string, text: string,
): ReadableStream {
  return new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();

      controller.enqueue(enc.encode(`data: ${JSON.stringify({
        id: completionId, object: "chat.completion.chunk", created, model,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      })}\n\n`));
      controller.enqueue(enc.encode(`data: ${JSON.stringify({
        id: completionId, object: "chat.completion.chunk", created, model,
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      })}\n\n`));
      controller.enqueue(enc.encode(`data: ${JSON.stringify({
        id: completionId, object: "chat.completion.chunk", created, model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`));
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}
