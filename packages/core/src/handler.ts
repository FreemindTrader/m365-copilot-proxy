import { copilotChat } from "./copilot.js";
import { ChatCompletionRequest } from "./schemas.js";
import { getToken } from "./auth.js";
import { getOrCreateAgent } from "./agent.js";
import { formatMessages, parseToolCalls } from "./tools.js";
import { createLogger } from "./log.js";
import type { z } from "zod/v4";

const log = createLogger("handler");

let cachedAgentId: string | null | undefined = undefined;

export interface HandlerOptions {
  /** Pre-resolved auth token. If not provided, getToken() is called. */
  getToken?: () => Promise<string>;
  /** Whether to attempt agent resolution. Default: true. */
  useAgent?: boolean;
}

type ChatBody = z.infer<typeof ChatCompletionRequest>;

/**
 * Handle a chat completion request in-process (no HTTP).
 * Takes a parsed OpenAI-format request body and returns a Response.
 */
export async function handleChatCompletion(
  body: ChatBody,
  options: HandlerOptions = {},
): Promise<Response> {
  const resolveToken = options.getToken ?? getToken;
  const useAgent = options.useAgent !== false;

  let token: string;
  try {
    token = await resolveToken();
  } catch (err: any) {
    return jsonResponse(401, { error: { message: err.message, type: "auth_error" } });
  }

  const hasTools = body.tools && body.tools.length > 0 && body.tool_choice !== "none";
  const model = body.model;

  // Resolve agent ID lazily
  if (useAgent && cachedAgentId === undefined) {
    try {
      cachedAgentId = await getOrCreateAgent();
      if (cachedAgentId) log.info(`Using agent: ${cachedAgentId}`);
      else log.info("No agent available, using prompt injection only");
    } catch {
      cachedAgentId = null;
    }
  }

  const text = formatMessages(body.messages, body.tools, body.tool_choice, {
    agentMode: !!cachedAgentId,
  });
  log.info(`Chat completion: model=${model}, stream=${body.stream}, messages=${body.messages.length}, tools=${body.tools?.length ?? 0}, agent=${!!cachedAgentId}`);
  log.debug("Formatted prompt:", text.slice(0, 1000));
  const completionId = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  let copilotStream;
  try {
    copilotStream = await copilotChat(token, text, model, cachedAgentId ? { agentId: cachedAgentId } : undefined);
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

    // Handle "reply" tool calls — these are the agent's way of producing text responses.
    // Convert them to plain text instead of forwarding as tool calls.
    if (parsed.hasToolCalls) {
      const replyCall = parsed.toolCalls.find(tc => tc.function.name === "reply");
      const realToolCalls = parsed.toolCalls.filter(tc => tc.function.name !== "reply");

      if (replyCall && realToolCalls.length === 0) {
        // Pure text response via reply tool
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

      // If there are real tool calls (possibly mixed with reply), forward the real ones
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
