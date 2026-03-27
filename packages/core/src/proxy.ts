import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { copilotChat, getAvailableModels } from "./copilot.js";
import { ChatCompletionRequest } from "./schemas.js";
import { getToken } from "./auth.js";
import { getOrCreateAgent } from "./agent.js";
import { formatMessages, parseToolCalls } from "./tools.js";
import { createLogger } from "./log.js";

const log = createLogger("proxy");

export interface ProxyOptions {
  /** Port to listen on. 0 = random available port. */
  port?: number;
  /** Pre-resolved auth token. If not provided, getToken() is called per-request. */
  getToken?: () => Promise<string>;
  /** Pre-resolved agent ID. If not provided, getOrCreateAgent() is called lazily. */
  agentId?: string | null;
  /** Whether to attempt agent resolution. Default: true. */
  useAgent?: boolean;
}

export interface ProxyServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

/**
 * Create and start the M365 proxy HTTP server.
 * Supports OpenAI-compatible /v1/chat/completions with tool calling and agent mode.
 */
export async function createProxyServer(options: ProxyOptions = {}): Promise<ProxyServer> {
  const resolveToken = options.getToken ?? getToken;
  const useAgent = options.useAgent !== false;
  let cachedAgentId: string | null | undefined = options.agentId !== undefined ? options.agentId : undefined;

  const server = createServer(async (req, res) => {
    const jsonRes = (status: number, body: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify(body));
    };

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      });
      return res.end();
    }

    const url = new URL(req.url!, `http://localhost`);
    log.info(`${req.method} ${url.pathname}`);

    try {
      if (url.pathname === "/health" && req.method === "GET") {
        return jsonRes(200, { status: "ok" });
      }

      if (url.pathname === "/v1/models" && req.method === "GET") {
        const created = Math.floor(Date.now() / 1000);
        return jsonRes(200, {
          object: "list",
          data: getAvailableModels().map((id) => ({
            id,
            object: "model",
            created,
            owned_by: "microsoft",
          })),
        });
      }

      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        // Extract token from Authorization header or resolve silently
        let token: string;
        const authHeader = req.headers["authorization"];
        if (authHeader && authHeader.startsWith("Bearer ") && authHeader.length > 20) {
          // Only use header token if it looks like a real token (not a placeholder)
          const headerToken = authHeader.slice(7);
          if (!headerToken.startsWith("not-needed") && !headerToken.startsWith("placeholder") && !headerToken.startsWith("sk-")) {
            token = headerToken;
          } else {
            token = await resolveToken();
          }
        } else {
          token = await resolveToken();
        }

        let body: ReturnType<typeof ChatCompletionRequest.parse>;
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          body = ChatCompletionRequest.parse(JSON.parse(Buffer.concat(chunks).toString()));
        } catch (err: any) {
          return jsonRes(400, { error: { message: err.message, type: "invalid_request_error" } });
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

        // Format messages — use compact mode when agent handles system prompt
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
          return jsonRes(502, { error: { message: err.message, type: "upstream_error" } });
        }

        // When tools are present, buffer full response to detect tool calls
        if (hasTools) {
          let fullText = "";
          try {
            for await (const delta of copilotStream) fullText += delta;
            if (copilotStream.fullText) fullText = copilotStream.fullText;

            if (!copilotStream.hasContent && fullText.length === 0) {
              const throttle = copilotStream.throttle;
              const msg = throttle
                ? `M365 Copilot rate limited (${throttle.current}/${throttle.max} messages used). Please wait and try again.`
                : "M365 Copilot returned an empty response. You may be rate limited. Please wait and try again.";
              log.error(msg);
              return jsonRes(429, { error: { message: msg, type: "rate_limit_error" } });
            }
          } catch (err: any) {
            return jsonRes(502, { error: { message: err.message, type: "upstream_error" } });
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
                writeStreamedText(res, completionId, created, model, replyText);
              } else {
                jsonRes(200, {
                  id: completionId, object: "chat.completion", created, model,
                  choices: [{ index: 0, message: { role: "assistant", content: replyText }, finish_reason: "stop" }],
                  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                });
              }
              return;
            }

            if (realToolCalls.length > 0) {
              parsed.toolCalls = realToolCalls;
            }
          }

          if (parsed.hasToolCalls && parsed.toolCalls.length > 0) {
            if (body.stream) {
              res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
                "Access-Control-Allow-Origin": "*",
              });

              res.write(`data: ${JSON.stringify({
                id: completionId, object: "chat.completion.chunk", created, model,
                choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
              })}\n\n`);

              for (let i = 0; i < parsed.toolCalls.length; i++) {
                const tc = parsed.toolCalls[i];
                res.write(`data: ${JSON.stringify({
                  id: completionId, object: "chat.completion.chunk", created, model,
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: i,
                        id: tc.id,
                        type: "function",
                        function: { name: tc.function.name, arguments: tc.function.arguments },
                      }],
                    },
                    finish_reason: null,
                  }],
                })}\n\n`);
              }

              res.write(`data: ${JSON.stringify({
                id: completionId, object: "chat.completion.chunk", created, model,
                choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
              })}\n\n`);
              res.write("data: [DONE]\n\n");
              res.end();
            } else {
              jsonRes(200, {
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
            // No tool calls — return as normal text
            if (body.stream) {
              writeStreamedText(res, completionId, created, model, fullText);
            } else {
              jsonRes(200, {
                id: completionId, object: "chat.completion", created, model,
                choices: [{ index: 0, message: { role: "assistant", content: fullText }, finish_reason: "stop" }],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
              });
            }
          }
        } else if (body.stream) {
          // No tools — pure streaming passthrough
          let hasAnything = false;
          try {
            for await (const delta of copilotStream) {
              if (!hasAnything) {
                res.writeHead(200, {
                  "Content-Type": "text/event-stream",
                  "Cache-Control": "no-cache",
                  Connection: "keep-alive",
                  "Access-Control-Allow-Origin": "*",
                });
                res.write(`data: ${JSON.stringify({
                  id: completionId, object: "chat.completion.chunk", created, model,
                  choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
                })}\n\n`);
                hasAnything = true;
              }
              res.write(`data: ${JSON.stringify({
                id: completionId, object: "chat.completion.chunk", created, model,
                choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
              })}\n\n`);
            }
          } catch {}

          if (!hasAnything && !copilotStream.hasContent) {
            const throttle = copilotStream.throttle;
            const msg = throttle
              ? `M365 Copilot rate limited (${throttle.current}/${throttle.max} messages used). Please wait and try again.`
              : "M365 Copilot returned an empty response. You may be rate limited. Please wait and try again.";
            log.error(msg);
            return jsonRes(429, { error: { message: msg, type: "rate_limit_error" } });
          }

          if (hasAnything) {
            res.write(`data: ${JSON.stringify({
              id: completionId, object: "chat.completion.chunk", created, model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            })}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
          }
        } else {
          // No tools, no streaming
          let fullText = "";
          try {
            for await (const delta of copilotStream) fullText += delta;
            if (copilotStream.fullText) fullText = copilotStream.fullText;
          } catch (err: any) {
            return jsonRes(502, { error: { message: err.message, type: "upstream_error" } });
          }

          if (!copilotStream.hasContent && fullText.length === 0) {
            const throttle = copilotStream.throttle;
            const msg = throttle
              ? `M365 Copilot rate limited (${throttle.current}/${throttle.max} messages used). Please wait and try again.`
              : "M365 Copilot returned an empty response. You may be rate limited. Please wait and try again.";
            log.error(msg);
            return jsonRes(429, { error: { message: msg, type: "rate_limit_error" } });
          }

          jsonRes(200, {
            id: completionId, object: "chat.completion", created, model,
            choices: [{ index: 0, message: { role: "assistant", content: fullText }, finish_reason: "stop" }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          });
        }
        return;
      }

      jsonRes(404, { error: { message: "Not found", type: "not_found" } });
    } catch (err: any) {
      log.error("Unhandled error:", err.message);
      jsonRes(500, { error: { message: "Internal server error", type: "server_error" } });
    }
  });

  const port = options.port ?? 0;

  return new Promise((resolve) => {
    server.listen(port, () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      log.info(`Proxy server started on port ${actualPort}`);
      resolve({
        server,
        port: actualPort,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

function writeStreamedText(res: ServerResponse, completionId: string, created: number, model: string, text: string) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.write(`data: ${JSON.stringify({
    id: completionId, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  })}\n\n`);
  res.write(`data: ${JSON.stringify({
    id: completionId, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  })}\n\n`);
  res.write(`data: ${JSON.stringify({
    id: completionId, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}
