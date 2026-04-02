import type { Plugin } from "@opencode-ai/plugin";
import { getToken, loginAutomated, createLogger } from "@opencode-m365/core";
import { createApp } from "@opencode-m365/proxy-lib";

const log = createLogger("opencode-plugin");

const app = createApp();

async function m365Fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
  return app.fetch(new Request(url, init));
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
    "experimental.chat.system.transform": async (_input, output) => {
      // Replace opencode's verbose system prompt with a minimal one.
      // Our tool-calling instructions are injected per-request by proxy-lib,
      // so the system prompt just needs basic context.
      output.system = [
        "You are a helpful coding assistant. TOOL USE IS REQUIRED when the user asks to read files, run commands, inspect the repo, or fetch data—never answer from memory. When calling a tool, output ONLY a single tool_call block (no other text). Do not explain your actions. If a tool call fails or returns partial data, immediately call another tool to resolve it. Do not defer work, ask the user to wait, or promise results later.",
      ];
    },

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
