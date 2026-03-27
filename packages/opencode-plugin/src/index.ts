import type { Plugin } from "@opencode-ai/plugin";
import {
  createProxyServer,
  getToken,
  loginAutomated,
  createLogger,
  formatMessages,
  formatToolDefinitions,
  parseToolCalls,
  TOOL_CALL_FENCE,
  TOOL_CALL_FENCE_CLOSE,
  type ParsedToolCall,
  type ParseResult,
  type ProxyServer,
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

// --- Plugin ---

let proxy: ProxyServer | null = null;

export const M365Plugin: Plugin = async (_input) => {
  log.info("Plugin init: starting proxy and acquiring token...");
  let port: number;
  try {
    await getToken();
    const p = await createProxyServer({ port: 0 });
    proxy = p;
    port = p.port;
    log.info(`Plugin init: proxy started on port ${port}`);
  } catch (err: any) {
    log.error("Plugin init failed:", err.message);
    const p = await createProxyServer({ port: 0 });
    proxy = p;
    port = p.port;
  }

  return {
    auth: {
      provider: "m365",

      async loader(_auth, _provider) {
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
