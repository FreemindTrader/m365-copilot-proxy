import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "./log.js";
import { getTokenForScope } from "./auth.js";

const log = createLogger("agent");

const CONFIG_DIR = join(homedir(), ".config", "opencode-m365");
const AGENT_CACHE_FILE = join(CONFIG_DIR, "agent-id.json");

const POWERPLATFORM_SCOPES = ["https://api.powerplatform.com/.default"];
const BAP_SCOPES = ["https://api.bap.microsoft.com/.default"];
const BAP_API = "https://api.bap.microsoft.com";

const AGENT_NAME = "m365-tool-agent";
const AGENT_DESCRIPTION = "Auto-created agent for tool calling";

// Minimal 48x48 blue square PNG as base64 (required for publishing)
const BOT_ICON_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAB3RJTUUH6AMbAAAoLbOJEAAAABl0RVh0Q29tbWVudABDcmVhdGVkIHdpdGggR0lNUFeBDhcAAAAoSURBVFjD7cExAQAAAMKg9U9tDB+gAAAAAAAAAAAAAAAAAAAAAAAA/BgwMAAB/0LuMgAAAABJRU5ErkJggg==";

function getAgentInstructions(): string {
  return `You are an AI assistant that follows the OpenAI tool-calling protocol.

You have access to one or more tools.

When a user asks something that requires a tool, you MUST respond ONLY with a JSON object of the form:
{
  "tool": "<tool_name>",
  "arguments": { ... }
}

Rules:
- Do NOT output anything except valid JSON.
- Do NOT add explanations, comments, or natural language.
- Tool name must match exactly the names provided.
- Arguments MUST be a valid JSON object and contain only data, no prose.
- If no tool is needed, respond normally with natural language.`;
}

async function getEnvironmentUrl(ppToken: string): Promise<string> {
  // Query BAP API to discover the default environment
  const res = await fetch(
    `${BAP_API}/providers/Microsoft.BusinessAppPlatform/environments/~default?api-version=2023-06-01`,
    {
      headers: {
        Authorization: `Bearer ${ppToken}`,
      },
    },
  );

  if (!res.ok) {
    throw new Error(`BAP API failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const envName: string = data.name; // e.g. "Default-fa7f56d8-49c4-4327-b816-9a0eeaa273df"
  const envId = envName
    .replace(/^Default-/i, "")
    .replace(/-/g, "")
    .toLowerCase();

  // Microsoft constructs the subdomain as "default{envId}" but DNS resolution
  // requires finding the correct label. Try the full ID first, fall back to
  // progressively shorter versions if DNS doesn't resolve.
  const base = `.df.environment.api.powerplatform.com`;
  const candidates = [
    `https://default${envId}${base}`,
    `https://default${envId.slice(0, -2)}${base}`, // some tenants truncate last 2 chars
  ];

  for (const url of candidates) {
    try {
      const probe = await fetch(
        `${url}/copilotstudio/minimalBots/api?api-version=2022-03-01-preview`,
        {
          method: "HEAD",
          headers: { Authorization: `Bearer ${ppToken}` },
        },
      );
      // Any response (even 401/403) means the host resolved
      log.info(`Resolved environment URL: ${url}`);
      return url;
    } catch {
      log.info(`Environment URL candidate failed: ${url}`);
    }
  }

  // Last resort: return the full version
  const fallback = candidates[0];
  log.info(`Using fallback environment URL: ${fallback}`);
  return fallback;
}

interface CachedAgent {
  agentId: string;
  botId: string;
  createdAt: string;
}

function loadCachedAgent(): CachedAgent | null {
  if (!existsSync(AGENT_CACHE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(AGENT_CACHE_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function saveCachedAgent(data: CachedAgent): void {
  writeFileSync(AGENT_CACHE_FILE, JSON.stringify(data, null, 2));
}

async function ppFetch(
  url: string,
  token: string,
  options: RequestInit = {},
): Promise<Response> {
  return fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "x-ms-user-agent": "PVA-Portal/1.0.0 (Web; ReactNative: false)",
      ...(options.headers as Record<string, string>),
    },
  });
}

async function listBots(
  envUrl: string,
  token: string,
): Promise<Array<{ botId: string; shortBotName: string }>> {
  const res = await ppFetch(
    `${envUrl}/copilotstudio/minimalBots/api?api-version=2022-03-01-preview`,
    token,
  );
  if (!res.ok)
    throw new Error(`Failed to list bots: ${res.status} ${await res.text()}`);
  return res.json();
}

async function createBot(
  envUrl: string,
  token: string,
): Promise<{ botId: string; componentId: string }> {
  const body = {
    botComponentChanges: [
      {
        component: {
          diagnostics: [],
          displayName: AGENT_NAME,
          id: "00000000-0000-0000-0000-000000000000",
          metadata: {
            tools: [],
            conversationStarters: [],
            diagnostics: [],
            instructions: {
              $kind: "TemplateLine",
              segments: [
                {
                  $kind: "TextSegment",
                  value: getAgentInstructions(),
                  diagnostics: [],
                },
              ],
              diagnostics: [],
            },
            knowledgeSources: {
              diagnostics: [],
              $kind: "SearchAllKnowledgeSources",
            },
            $kind: "GptComponentMetadata",
            gptCapabilities: {
              diagnostics: [],
              $kind: "GptCapabilities",
              codeInterpreter: false,
              generateImages: false,
              webBrowsing: false,
              searchOneDriveAndSharePoint: false,
              searchTeams: false,
              searchMeetings: false,
              searchEmails: false,
              searchPeople: false,
            },
            aISettings: {
              diagnostics: [],
              $kind: "AISettings",
              useModelKnowledge: true,
            },
          },
          schemaName: "00000000-0000-0000-0000-000000000000.gpt.default",
          $kind: "GptComponent",
          description: AGENT_DESCRIPTION,
        },
        $kind: "BotComponentInsert",
      },
    ],
    cloudFlowDefinitionChanges: [],
    connectorDefinitionChanges: [],
    environmentVariableChanges: [],
    connectionReferenceChanges: [],
    aIPluginOperationChanges: [],
    componentCollectionChanges: [],
    dataverseTableSearchChanges: [],
    dataverseTableSearchEntityConfigurationChanges: [],
    dataverseTableSearchGlossaryConfigurationChanges: [],
    dataverseTableSearchEntityColumnSynonymChanges: [],
    aIModelChanges: [],
    connectedAgentDefinitionChanges: [],
    bot: {
      authorizedSecurityGroupIds: [],
      supportedLanguages: [],
      diagnostics: [],
      displayName: AGENT_NAME,
      language: 1033,
      schemaName: "00000000-0000-0000-0000-000000000000",
      template: "gpt-1.1.0",
      $kind: "BotEntity",
      iconBase64: BOT_ICON_BASE64,
    },
  };

  const res = await ppFetch(
    `${envUrl}/copilotstudio/minimalBots/api?api-version=2022-03-01-preview`,
    token,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );

  if (!res.ok)
    throw new Error(`Failed to create bot: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const botId = data.bot?.schemaName || data.bot?.cdsBotId;
  const componentId = data.botComponentChanges?.[0]?.component?.id;
  const changeToken = data.changeToken;
  return { botId, componentId, changeToken };
}

async function updateBotInstructions(
  envUrl: string,
  token: string,
  botId: string,
  componentId: string,
  changeToken: string,
): Promise<void> {
  // Update with instructions using the changeToken from bot creation
  const updateBody = {
    botComponentChanges: [
      {
        component: {
          $kind: "GptComponent",
          id: componentId,
          parentBotId: botId,
          displayName: AGENT_NAME,
          description: AGENT_DESCRIPTION,
          schemaName: `${botId}.gpt.default`,
          metadata: {
            $kind: "GptComponentMetadata",
            instructions: {
              $kind: "TemplateLine",
              segments: [
                {
                  $kind: "TextSegment",
                  value: getAgentInstructions(),
                  diagnostics: [],
                },
              ],
              diagnostics: [],
            },
            knowledgeSources: {
              $kind: "SearchAllKnowledgeSources",
              diagnostics: [],
            },
            gptCapabilities: {
              $kind: "GptCapabilities",
              webBrowsing: false,
              codeInterpreter: false,
              generateImages: false,
              searchTeams: false,
              searchOneDriveAndSharePoint: false,
              searchEmails: false,
              searchMeetings: false,
              searchPeople: false,
              diagnostics: [],
            },
            conversationStarters: [],
            aISettings: {
              $kind: "AISettings",
              useModelKnowledge: true,
              diagnostics: [],
            },
            tools: [],
            diagnostics: [],
          },
          diagnostics: [],
        },
        $kind: "BotComponentUpdate",
      },
    ],
    changeToken,
  };

  const res = await ppFetch(
    `${envUrl}/copilotstudio/minimalBots/api/${botId}/components?api-version=2022-03-01-preview`,
    token,
    {
      method: "PUT",
      body: JSON.stringify(updateBody),
    },
  );

  if (!res.ok)
    throw new Error(
      `Failed to update bot instructions: ${res.status} ${await res.text()}`,
    );
}

async function publishBot(
  envUrl: string,
  token: string,
  botId: string,
): Promise<string> {
  // Publish the bot to M365 Copilot — returns the TitleId needed for chat
  const res = await ppFetch(
    `${envUrl}/copilotstudio/minimalBots/api/${botId}/publish?api-version=2022-03-01-preview`,
    token,
    {
      method: "POST",
    },
  );

  if (!res.ok)
    throw new Error(`Failed to publish bot: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const titleId: string = data.TitleId;
  if (!titleId) throw new Error("Publish response missing TitleId");
  log.info(`Published agent: TitleId=${titleId}`);
  return titleId;
}

/**
 * Get or create the opencode tool-calling agent.
 * Returns the agent ID to pass to copilotChat, or null if agent creation isn't possible.
 */
export async function getOrCreateAgent(): Promise<string | null> {
  // Check cache first
  const cached = loadCachedAgent();
  if (cached) {
    log.info(`Using cached agent: ${cached.agentId}`);
    return cached.agentId;
  }

  // Need BAP token for environment discovery
  const bapToken = await getTokenForScope(BAP_SCOPES);
  if (!bapToken) {
    log.info("No BAP token available — skipping agent creation");
    return null;
  }

  // Need PowerPlatform token for Copilot Studio APIs
  const ppToken = await getTokenForScope(POWERPLATFORM_SCOPES);
  if (!ppToken) {
    log.info("No PowerPlatform token available — skipping agent creation");
    return null;
  }

  const envUrl = await getEnvironmentUrl(bapToken);

  try {
    log.info(`PowerPlatform env URL: ${envUrl}`);
    // Check if our agent already exists
    const bots = await listBots(envUrl, ppToken);
    let botId: string | null = null;

    const existing = bots.find((b) => b.shortBotName === AGENT_NAME);
    if (existing) {
      log.info(`Found existing agent: ${existing.botId}`);
      botId = existing.botId;
    } else {
      // Create a new agent
      log.info("Creating new tool-calling agent...");
      const created = await createBot(envUrl, ppToken);
      botId = created.botId;
      log.info(`Created agent: botId=${botId}`);
    }

    // Publish to M365 Copilot and get the TitleId
    let titleId: string;
    try {
      titleId = await publishBot(envUrl, ppToken, botId);
    } catch (pubErr: any) {
      // If publish fails (e.g. missing icon/instructions on legacy bot), delete and recreate
      log.info(
        `Publish failed (${pubErr.message.slice(0, 100)}), deleting and recreating bot...`,
      );
      await ppFetch(
        `${envUrl}/copilotstudio/minimalBots/api/${botId}?api-version=2022-03-01-preview`,
        ppToken,
        {
          method: "DELETE",
        },
      );
      const created = await createBot(envUrl, ppToken);
      botId = created.botId;
      log.info(`Recreated agent: botId=${botId}`);
      titleId = await publishBot(envUrl, ppToken, botId);
    }
    const agentId = `${titleId}.${botId}.gpt.default`;
    log.info(`Full agent ID: ${agentId}`);

    // Cache it
    saveCachedAgent({ agentId, botId, createdAt: new Date().toISOString() });
    return agentId;
  } catch (err: any) {
    log.error("Agent creation failed:", err.message, err.cause?.message || "");
    return null;
  }
}
