import type { Plugin } from "@opencode-ai/plugin";
import { createServer, type Server } from "node:http";
import {
  ChatCompletionRequest,
  copilotChat,
  getAvailableModels,
  getToken,
  loginAutomated,
  getTokenSilent,
} from "@opencode-m365/core";

// --- Embedded proxy ---

let proxyServer: Server | null = null;
let proxyPort: number | null = null;

function formatMessages(messages: Array<{ role: string; content: string | any[] }>): string {
  if (messages.length === 1 && messages[0].role === "user") {
    const c = messages[0].content;
    return typeof c === "string" ? c : c.map((p: any) => p.text || "").join("");
  }
  return messages
    .map((m) => {
      const content =
        typeof m.content === "string"
          ? m.content
          : m.content.map((p: any) => p.text || "").join("");
      return `[${m.role}]\n${content}`;
    })
    .join("\n\n");
}

async function startProxy(): Promise<number> {
  if (proxyServer && proxyPort) return proxyPort;

  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const jsonRes = (status: number, body: unknown) => {
        res.writeHead(status, {
          "Content-Type": status === 200 && req.url?.includes("stream") ? "text/event-stream" : "application/json",
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

        const text = formatMessages(body.messages);
        const completionId = `chatcmpl-${crypto.randomUUID()}`;
        const created = Math.floor(Date.now() / 1000);
        const model = body.model;

        let stream;
        try {
          stream = await copilotChat(token, text, model);
        } catch (err: any) {
          return jsonRes(502, { error: { message: err.message, type: "upstream_error" } });
        }

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

          try {
            for await (const delta of stream) {
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
          let fullText = "";
          try {
            for await (const delta of stream) fullText += delta;
            if (stream.fullText) fullText = stream.fullText;
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
      console.log(`[m365-plugin] Embedded proxy on port ${port}`);
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
            } catch {
              return { type: "failed" as const };
            }
          },
        },
      ],
    },
  };
};

export default M365Plugin;
