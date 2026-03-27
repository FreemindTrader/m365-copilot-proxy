import type { Plugin } from "@opencode-ai/plugin";
import {
  getToken,
  getAvailableModels,
  loginAutomated,
  createLogger,
  handleChatCompletion,
  ChatCompletionRequest,
  formatMessages,
  formatToolDefinitions,
  parseToolCalls,
  TOOL_CALL_FENCE,
  TOOL_CALL_FENCE_CLOSE,
  type ParsedToolCall,
  type ParseResult,
} from "@opencode-m365/core";

const log = createLogger("opencode-plugin");

// Re-export shared utilities for tests
export {
  formatMessages,
  formatToolDefinitions,
  parseToolCalls,
  TOOL_CALL_FENCE,
  TOOL_CALL_FENCE_CLOSE,
  type ParsedToolCall,
  type ParseResult,
};

/**
 * Custom fetch that intercepts OpenAI-compatible requests and handles them
 * in-process via M365 Copilot — no HTTP proxy needed.
 */
async function m365Fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
  const method = init?.method || "GET";

  log.info(`${method} ${url.pathname}`);

  // GET /v1/models
  if (url.pathname.endsWith("/models") && method === "GET") {
    const created = Math.floor(Date.now() / 1000);
    return new Response(JSON.stringify({
      object: "list",
      data: getAvailableModels().map((id) => ({
        id,
        object: "model",
        created,
        owned_by: "microsoft",
      })),
    }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // POST /v1/chat/completions
  if (url.pathname.endsWith("/chat/completions") && method === "POST") {
    try {
      const rawBody = typeof init?.body === "string"
        ? init.body
        : init?.body instanceof ArrayBuffer
          ? new TextDecoder().decode(init.body)
          : init?.body instanceof Uint8Array
            ? new TextDecoder().decode(init.body)
            : await new Response(init?.body).text();

      const body = ChatCompletionRequest.parse(JSON.parse(rawBody));
      return await handleChatCompletion(body);
    } catch (err: any) {
      log.error("Chat completion error:", err.message);
      return new Response(JSON.stringify({
        error: { message: err.message, type: "invalid_request_error" },
      }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // Fallback
  return new Response(JSON.stringify({ error: { message: "Not found" } }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}

// --- Plugin ---

export const M365Plugin: Plugin = async (_input) => {
  log.info("Plugin init: acquiring token...");
  try {
    await getToken();
    log.info("Plugin init: auth OK");
  } catch (err: any) {
    log.error("Plugin init: auth failed:", err.message);
  }

  return {
    auth: {
      provider: "m365",

      async loader(_auth, _provider) {
        return {
          baseURL: "https://m365-copilot.local/v1",
          apiKey: "",
          fetch: m365Fetch,
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
