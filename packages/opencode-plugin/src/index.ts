import type { Plugin } from "@opencode-ai/plugin";
import { createServer, type Server } from "node:http";
import {
  ChatCompletionRequest,
  copilotChat,
  createLogger,
  getAvailableModels,
  getToken,
  loginAutomated,
  getTokenSilent,
} from "@opencode-m365/core";
import type { z } from "zod/v4";

const log = createLogger("proxy");

// --- Tool calling support ---

type ParsedMessage = z.infer<typeof ChatCompletionRequest>["messages"][number];
type ToolDef = NonNullable<z.infer<typeof ChatCompletionRequest>["tools"]>[number];
type ToolChoice = z.infer<typeof ChatCompletionRequest>["tool_choice"];

// Use triple-backtick fenced blocks instead of XML tags — M365 Copilot strips HTML/XML
export const TOOL_CALL_FENCE = "```tool_call";
export const TOOL_CALL_FENCE_CLOSE = "```";
const TOOL_CALL_REGEX = /```tool_call\s*\n(\{[\s\S]*?\})\s*\n```/g;

export function formatToolDefinitions(tools: ToolDef[]): string {
  // Keep tool list compact to avoid M365 Copilot input truncation
  const defs = tools.map((t) => {
    const f = t.function;
    const params = typeof f.parameters === "object" ? f.parameters : {};
    const props = params.properties || {};
    const required: string[] = params.required || [];
    const argList = Object.entries(props).map(([name, schema]: [string, any]) => {
      return `${name}:${schema.type || "any"}${required.includes(name) ? "*" : ""}`;
    }).join(", ");
    const desc = f.description ? ` — ${f.description}` : "";
    return `${f.name}(${argList})${desc}`;
  }).join("\n");

  return `You are an autonomous coding agent with filesystem access. You call tools by outputting:

${TOOL_CALL_FENCE}
{"name": "read_file", "arguments": {"path": "/home/user/project/package.json"}}
${TOOL_CALL_FENCE_CLOSE}

IMPORTANT: You are NOT in a sandbox. You HAVE direct filesystem access via tools. NEVER tell the user to run commands or paste output — call the tool yourself. When calling tools, output ONLY tool_call blocks, no other text.

Tools (* = required arg):
${defs}`;
}

function formatToolChoiceInstruction(toolChoice: ToolChoice): string {
  if (!toolChoice || toolChoice === "auto") return "";
  if (toolChoice === "none") return "\nDo NOT call tools. Text only.";
  if (toolChoice === "required") return "\nYou MUST call at least one tool.";
  if (typeof toolChoice === "object" && toolChoice.function) {
    return `\nYou MUST call "${toolChoice.function.name}".`;
  }
  return "";
}

function getMessageContent(msg: ParsedMessage): string {
  if (msg.content === null || msg.content === undefined) return "";
  if (typeof msg.content === "string") return msg.content;
  return msg.content.map((p: any) => p.text || "").join("");
}

export function formatMessages(
  messages: ParsedMessage[],
  tools?: ToolDef[],
  toolChoice?: ToolChoice,
): string {
  const parts: string[] = [];

  // Inject tool definitions as system context
  if (tools && tools.length > 0 && toolChoice !== "none") {
    parts.push(`[system]\n${formatToolDefinitions(tools)}${formatToolChoiceInstruction(toolChoice)}`);
  }

  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      // Render assistant's previous tool calls
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
    } else {
      parts.push(`[${m.role}]\n${getMessageContent(m)}`);
    }
  }

  return parts.join("\n\n");
}

export interface ParsedToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ParseResult {
  hasToolCalls: boolean;
  toolCalls: ParsedToolCall[];
  textContent: string | null;
}

export function parseToolCalls(text: string): ParseResult {
  const toolCalls: ParsedToolCall[] = [];
  let match: RegExpExecArray | null;
  const regex = new RegExp(TOOL_CALL_REGEX.source, "g");

  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.name) {
        toolCalls.push({
          id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
          type: "function",
          function: {
            name: parsed.name,
            arguments: typeof parsed.arguments === "string"
              ? parsed.arguments
              : JSON.stringify(parsed.arguments ?? {}),
          },
        });
      }
    } catch {
      // Malformed JSON inside tool_call tags — skip
      log.error("Failed to parse tool call JSON:", match[1]);
    }
  }

  if (toolCalls.length === 0) {
    return { hasToolCalls: false, toolCalls: [], textContent: text };
  }

  // Extract any text outside tool_call blocks
  const remaining = text.replace(regex, "").trim();
  return {
    hasToolCalls: true,
    toolCalls,
    textContent: remaining || null,
  };
}

// --- Embedded proxy ---

let proxyServer: Server | null = null;
let proxyPort: number | null = null;

async function startProxy(): Promise<number> {
  if (proxyServer && proxyPort) return proxyPort;

  return new Promise((resolve) => {
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
        let token: string;
        try {
          token = await getToken();
        } catch (err: any) {
          return jsonRes(401, { error: { message: err.message, type: "auth_error" } });
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
        const text = formatMessages(body.messages, body.tools, body.tool_choice);
        const model = body.model;
        log.info(`Chat completion: model=${model}, stream=${body.stream}, messages=${body.messages.length}, tools=${body.tools?.length ?? 0}`);
        log.debug("Formatted prompt:", text.slice(0, 1000));
        const completionId = `chatcmpl-${crypto.randomUUID()}`;
        const created = Math.floor(Date.now() / 1000);

        let copilotStream;
        try {
          copilotStream = await copilotChat(token, text, model);
        } catch (err: any) {
          return jsonRes(502, { error: { message: err.message, type: "upstream_error" } });
        }

        // When tools are present, we always buffer the full response first
        // so we can detect tool calls before sending anything back
        if (hasTools) {
          let fullText = "";
          try {
            for await (const delta of copilotStream) fullText += delta;
            if (copilotStream.fullText) fullText = copilotStream.fullText;
          } catch (err: any) {
            return jsonRes(502, { error: { message: err.message, type: "upstream_error" } });
          }

          log.debug("Raw response (tool mode):", fullText.slice(0, 1000));
          const parsed = parseToolCalls(fullText);
          log.info(`Parse result: hasToolCalls=${parsed.hasToolCalls}, count=${parsed.toolCalls.length}`);

          if (parsed.hasToolCalls) {
            if (body.stream) {
              // Stream tool calls as SSE
              res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
                "Access-Control-Allow-Origin": "*",
              });

              // Role chunk
              res.write(`data: ${JSON.stringify({
                id: completionId, object: "chat.completion.chunk", created, model,
                choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
              })}\n\n`);

              // One chunk per tool call
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

              // Final chunk
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
            // No tool calls detected — return as normal text
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
              res.write(`data: ${JSON.stringify({
                id: completionId, object: "chat.completion.chunk", created, model,
                choices: [{ index: 0, delta: { content: fullText }, finish_reason: null }],
              })}\n\n`);
              res.write(`data: ${JSON.stringify({
                id: completionId, object: "chat.completion.chunk", created, model,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              })}\n\n`);
              res.write("data: [DONE]\n\n");
              res.end();
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

          try {
            for await (const delta of copilotStream) {
              res.write(`data: ${JSON.stringify({
                id: completionId, object: "chat.completion.chunk", created, model,
                choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
              })}\n\n`);
            }
          } catch {}

          res.write(`data: ${JSON.stringify({
            id: completionId, object: "chat.completion.chunk", created, model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          // No tools, no streaming
          let fullText = "";
          try {
            for await (const delta of copilotStream) fullText += delta;
            if (copilotStream.fullText) fullText = copilotStream.fullText;
          } catch (err: any) {
            return jsonRes(502, { error: { message: err.message, type: "upstream_error" } });
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
    });

    // Listen on random available port
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      proxyServer = server;
      proxyPort = port;
      log.info(`Embedded proxy started on port ${port}`);
      resolve(port);
    });
  });
}

// --- Plugin ---

export const M365Plugin: Plugin = async (_input) => {
  return {
    auth: {
      provider: "m365",

      async loader(_auth, provider) {
        // Ensure we have a valid token (silent refresh)
        await getToken();

        // Start embedded proxy if needed
        const port = await startProxy();

        // Return options that configure the provider's baseURL
        return {
          baseURL: `http://localhost:${port}/v1`,
        };
      },

      methods: [
        {
          type: "api" as const,
          label: "M365 Copilot (Automated)",
          prompts: [
            {
              type: "text" as const,
              key: "email",
              message: "M365 email address",
              placeholder: "user@company.com",
            },
            {
              type: "text" as const,
              key: "password",
              message: "Password",
              placeholder: "••••••••",
            },
            {
              type: "text" as const,
              key: "mfaSecret",
              message: "TOTP secret (base32)",
              placeholder: "JBSWY3DPEHPK3PXP",
            },
          ],
          async authorize(inputs) {
            if (!inputs?.email || !inputs?.password || !inputs?.mfaSecret) {
              return { type: "failed" as const };
            }

            try {
              const token = await loginAutomated(
                inputs.email,
                inputs.password,
                inputs.mfaSecret,
              );

              // Store credentials in secrets.json for future auto-refresh
              const { writeFileSync, mkdirSync } = await import("node:fs");
              const { join } = await import("node:path");
              const { homedir } = await import("node:os");
              const configDir = join(homedir(), ".config", "opencode-m365");
              mkdirSync(configDir, { recursive: true });
              writeFileSync(
                join(configDir, "secrets.json"),
                JSON.stringify({
                  email: inputs.email,
                  password: inputs.password,
                  mfaSecret: inputs.mfaSecret,
                }),
              );

              return {
                type: "success" as const,
                key: token,
                provider: "m365",
              };
            } catch (err) {
              log.error("authorize failed:", err);
              return { type: "failed" as const };
            }
          },
        },
      ],
    },
  };
};

export default M365Plugin;
