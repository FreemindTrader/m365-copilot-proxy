import {
  ModelSession,
  type ModelSessionOptions,
  createLogger,
  formatMessages,
  parseToolCalls,
  getMessageContent,
} from "@opencode-m365/core";
import { ChatCompletionRequest } from "./schemas.js";
import type { z } from "zod/v4";

const log = createLogger("handler");

type ChatBody = z.infer<typeof ChatCompletionRequest>;
type ParsedMessage = ChatBody["messages"][number];

// --- Per-conversation state ---

interface ConversationState {
  session: ModelSession;
  sentMessageCount: number;
  lastAccessedAt: number;
}

// --- Session pool: maps conversation fingerprint → M365 session ---

const MAX_IDLE_MS = 30 * 60 * 1000; // evict after 30 min idle

export class SessionPool {
  private conversations = new Map<string, ConversationState>();
  private sessionOptions: ModelSessionOptions;

  constructor(sessionOptions: ModelSessionOptions = {}) {
    this.sessionOptions = sessionOptions;
  }

  /**
   * Resolve the conversation state for an incoming request.
   * Fingerprint is the hash of the first user message — same first user message = same conversation.
   */
  resolve(messages: ParsedMessage[]): ConversationState {
    this.evictStale();

    const fingerprint = this.fingerprint(messages);
    const existing = this.conversations.get(fingerprint);

    if (existing) {
      // Messages shrunk means client restarted this conversation — reset M365 session
      if (messages.length < existing.sentMessageCount) {
        log.info(`Conversation ${fingerprint}: messages shrunk (${messages.length} < ${existing.sentMessageCount}), resetting`);
        existing.session.reset();
        existing.sentMessageCount = 0;
      }
      existing.lastAccessedAt = Date.now();
      return existing;
    }

    // New conversation
    log.info(`New conversation ${fingerprint}, ${this.conversations.size} active`);
    const state: ConversationState = {
      session: new ModelSession(this.sessionOptions),
      sentMessageCount: 0,
      lastAccessedAt: Date.now(),
    };
    this.conversations.set(fingerprint, state);
    return state;
  }

  private fingerprint(messages: ParsedMessage[]): string {
    const firstUser = messages.find(m => m.role === "user");
    const text = firstUser ? getMessageContent(firstUser) : "";
    return simpleHash(text);
  }

  private evictStale() {
    const now = Date.now();
    for (const [key, state] of this.conversations) {
      if (now - state.lastAccessedAt > MAX_IDLE_MS) {
        log.info(`Evicting idle conversation ${key}`);
        this.conversations.delete(key);
      }
    }
  }

  get size(): number {
    return this.conversations.size;
  }
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return String(hash);
}

// --- Delta message formatting ---

function formatDeltaMessages(messages: ParsedMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      const calls = m.tool_calls.map((tc) => {
        const args = typeof tc.function.arguments === "string"
          ? tc.function.arguments
          : JSON.stringify(tc.function.arguments);
        return `{"tool": "${tc.function.name}", "arguments": ${args}}`;
      }).join("\n");
      const content = getMessageContent(m);
      parts.push(`<assistant>${content ? "\n" + content : ""}\n${calls}\n</assistant>`);
    } else if (m.role === "tool") {
      const name = m.name || "unknown";
      const callId = m.tool_call_id || "?";
      parts.push(`<tool_response name="${name}" call_id="${callId}">\n${getMessageContent(m)}\n</tool_response>`);
    } else if (m.role === "system") {
      // Skip system messages on follow-up turns
    } else {
      parts.push(`<${m.role}>\n${getMessageContent(m)}\n</${m.role}>`);
    }
  }
  return parts.join("\n\n");
}

// --- Main handler ---

/**
 * Handle a chat completion request, returning an OpenAI-compatible Response.
 * The SessionPool routes each conversation to its own ModelSession.
 */
export async function handleChatCompletion(
  body: ChatBody,
  pool: SessionPool,
): Promise<Response> {
  const conv = pool.resolve(body.messages);
  const { session } = conv;
  const hasTools = body.tools && body.tools.length > 0 && body.tool_choice !== "none";
  const model = body.model;

  // Format message: full prompt on first turn, delta on follow-ups.
  // M365 is stateful — it remembers everything from prior turns,
  // so we only need to send new messages after the first turn.
  const isFirstTurn = session.turnCount === 0;
  const convId = session.conversationId;
  let text: string;
  if (isFirstTurn || conv.sentMessageCount === 0) {
    text = formatMessages(body.messages, body.tools, body.tool_choice, convId);
    log.info(`Chat completion: model=${model}, stream=${body.stream}, messages=${body.messages.length}, turn=${session.turnCount}, mode=full, cid=${convId}`);
  } else {
    const newMessages = body.messages.slice(conv.sentMessageCount);
    if (newMessages.length > 0) {
      text = formatDeltaMessages(newMessages);
      log.info(`Chat completion: model=${model}, stream=${body.stream}, messages=${body.messages.length}, new=${newMessages.length}, turn=${session.turnCount}, mode=delta, cid=${convId}`);
    } else {
      // Same message count = retry. M365 already has the context, just nudge it.
      text = "Please continue.";
      log.info(`Chat completion: model=${model}, stream=${body.stream}, messages=${body.messages.length}, turn=${session.turnCount}, mode=retry, cid=${convId}`);
    }
  }

  conv.sentMessageCount = body.messages.length;
  log.debug("Formatted prompt:", text.slice(0, 1000));

  const completionId = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  let copilotStream;
  try {
    copilotStream = await session.run(text, model);
  } catch (err: any) {
    return jsonResponse(502, { error: { message: err.message, type: "upstream_error" } });
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
