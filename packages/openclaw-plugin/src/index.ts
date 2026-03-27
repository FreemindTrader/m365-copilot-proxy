import {
  createProxyServer,
  getToken,
  getAvailableModels,
  createLogger,
  type ProxyServer,
  type ProxyOptions,
} from "@opencode-m365/core";

const log = createLogger("openclaw-plugin");

// Re-export core utilities that consumers may need
export { getAvailableModels, createProxyServer, type ProxyServer, type ProxyOptions };

// --- OpenClaw config generation ---

export interface OpenClawModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

export interface OpenClawProviderConfig {
  baseUrl: string;
  apiKey: string;
  api: string;
  models: OpenClawModelConfig[];
}

export interface OpenClawConfig {
  models: {
    mode: "merge";
    providers: {
      m365: OpenClawProviderConfig;
    };
  };
  agents: {
    defaults: {
      models: Record<string, { alias: string }>;
    };
  };
}

const MODEL_DISPLAY_NAMES: Record<string, string> = {
  "m365-copilot": "M365 Copilot (Auto)",
  "auto": "M365 Auto",
  "quick": "GPT Quick",
  "think-deeper": "GPT Think Deeper",
  "gpt-5.4": "GPT-5.4 Think Deeper",
  "gpt-5.4-quick": "GPT-5.4 Quick",
  "gpt-5.4-think-deeper": "GPT-5.4 Think Deeper",
  "gpt-5.3": "GPT-5.3 Quick",
  "gpt-5.3-quick": "GPT-5.3 Quick",
  "gpt-5.3-think-deeper": "GPT-5.3 Think Deeper",
  "gpt-5.2": "GPT-5.2 Quick",
  "gpt-5.2-quick": "GPT-5.2 Quick",
  "gpt-5.2-think-deeper": "GPT-5.2 Think Deeper",
};

const REASONING_MODELS = new Set([
  "think-deeper",
  "gpt-5.4", "gpt-5.4-think-deeper",
  "gpt-5.3-think-deeper",
  "gpt-5.2-think-deeper",
]);

/**
 * Generate the OpenClaw provider config for M365 Copilot.
 */
export function generateOpenClawConfig(proxyPort: number = 4141): OpenClawConfig {
  const models = getAvailableModels();

  const modelConfigs: OpenClawModelConfig[] = models.map((id) => ({
    id,
    name: MODEL_DISPLAY_NAMES[id] || id,
    reasoning: REASONING_MODELS.has(id),
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  }));

  const modelAllowlist: Record<string, { alias: string }> = {};
  for (const id of models) {
    modelAllowlist[`m365/${id}`] = { alias: id };
  }

  return {
    models: {
      mode: "merge",
      providers: {
        m365: {
          baseUrl: `http://localhost:${proxyPort}/v1`,
          apiKey: "not-needed",
          api: "openai-completions",
          models: modelConfigs,
        },
      },
    },
    agents: {
      defaults: {
        models: modelAllowlist,
      },
    },
  };
}

/**
 * Start the M365 proxy and return the OpenClaw config pointing to it.
 */
export async function startForOpenClaw(options: ProxyOptions = {}): Promise<{
  proxy: ProxyServer;
  config: OpenClawConfig;
}> {
  log.info("Starting M365 proxy for OpenClaw...");

  // Ensure we have a valid token
  try {
    await getToken();
  } catch (err: any) {
    log.error("Auth failed:", err.message);
    throw err;
  }

  const proxy = await createProxyServer({
    port: options.port ?? 4141,
    ...options,
  });

  const config = generateOpenClawConfig(proxy.port);
  log.info(`Proxy started on port ${proxy.port}`);

  return { proxy, config };
}
