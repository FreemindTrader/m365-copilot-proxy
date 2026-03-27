import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "./log.js";
import { getTokenForScope, getToken } from "./auth.js";
import { decodeJwt } from "./copilot.js";

const log = createLogger("agent");

const CONFIG_DIR = join(homedir(), ".config", "opencode-m365");
const AGENT_CACHE_FILE = join(CONFIG_DIR, "agent-id.json");

const POWERPLATFORM_SCOPES = ["https://api.powerplatform.com/.default"];

const AGENT_NAME = "opencode-m365-tool-agent";
const AGENT_DESCRIPTION = "Auto-created agent for opencode tool calling";

function getAgentInstructions(): string {
  return `When you need to perform an action, you MUST output EXACTLY this format with NO other text:

\`\`\`tool_call
{"name": "TOOL_NAME", "arguments": {"arg": "value"}}
\`\`\`

Rules:
1. When asked to read a file → output a tool_call block with read_file
2. When asked to list files → output a tool_call block with list_directory
3. When asked to run a command → output a tool_call block with bash
4. When asked to write a file → output a tool_call block with write_file
5. NEVER describe what you would do — output the tool_call block
6. NEVER say "I would use" or "I can" — just output the tool_call block
7. For questions that don't need tools, respond with plain text only`;
}

function getEnvironmentUrl(tenantId: string): string {
  const cleaned = tenantId.replace(/-/g, "");
  return `https://default${cleaned}.df.environment.api.powerplatform.com`;
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

async function ppFetch(url: string, token: string, options: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      "x-ms-user-agent": "PVA-Portal/1.0.0 (Web; ReactNative: false)",
      ...options.headers as Record<string, string>,
    },
  });
}

async function listBots(envUrl: string, token: string): Promise<Array<{ botId: string; shortBotName: string }>> {
  const res = await ppFetch(`${envUrl}/copilotstudio/minimalBots/api?api-version=2022-03-01-preview`, token);
  if (!res.ok) throw new Error(`Failed to list bots: ${res.status} ${await res.text()}`);
  return res.json();
}

async function createBot(envUrl: string, token: string): Promise<{ botId: string; componentId: string }> {
  const body = {
    botComponentChanges: [{
      component: {
        diagnostics: [],
        displayName: AGENT_NAME,
        id: "00000000-0000-0000-0000-000000000000",
        metadata: {
          tools: [],
          conversationStarters: [],
          diagnostics: [],
          knowledgeSources: { diagnostics: [], $kind: "SearchAllKnowledgeSources" },
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
          aISettings: { diagnostics: [], $kind: "AISettings", useModelKnowledge: true },
        },
        schemaName: "00000000-0000-0000-0000-000000000000.gpt.default",
        $kind: "GptComponent",
        description: AGENT_DESCRIPTION,
      },
      $kind: "BotComponentInsert",
    }],
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
    },
  };

  const res = await ppFetch(`${envUrl}/copilotstudio/minimalBots/api?api-version=2022-03-01-preview`, token, {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Failed to create bot: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const botId = data.bot?.schemaName || data.bot?.cdsBotId;
  const componentId = data.botComponentChanges?.[0]?.component?.id;
  return { botId, componentId };
}

async function updateBotInstructions(envUrl: string, token: string, botId: string, componentId: string): Promise<void> {
  // First get the current component to get the version/changeToken
  const listRes = await ppFetch(`${envUrl}/copilotstudio/minimalBots/api/${botId}/components?api-version=2022-03-01-preview`, token, {
    method: "POST",
    body: JSON.stringify({ componentDeltaToken: "" }),
  });
  if (!listRes.ok) throw new Error(`Failed to get components: ${listRes.status}`);
  const listData = await listRes.json();
  const changeToken = listData.changeToken;

  // Get current component state
  const getRes = await ppFetch(`${envUrl}/copilotstudio/minimalBots/api/${botId}/components?api-version=2022-03-01-preview`, token, {
    method: "POST",
    body: JSON.stringify({ componentDeltaToken: changeToken }),
  });

  // Now update with instructions
  const updateBody = {
    botComponentChanges: [{
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
            segments: [{
              $kind: "TextSegment",
              value: getAgentInstructions(),
              diagnostics: [],
            }],
            diagnostics: [],
          },
          knowledgeSources: { $kind: "SearchAllKnowledgeSources", diagnostics: [] },
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
          aISettings: { $kind: "AISettings", useModelKnowledge: true, diagnostics: [] },
          tools: [],
          diagnostics: [],
        },
        diagnostics: [],
      },
      $kind: "BotComponentUpdate",
    }],
    changeToken,
  };

  const res = await ppFetch(`${envUrl}/copilotstudio/minimalBots/api/${botId}/components?api-version=2022-03-01-preview`, token, {
    method: "PUT",
    body: JSON.stringify(updateBody),
  });

  if (!res.ok) throw new Error(`Failed to update bot instructions: ${res.status} ${await res.text()}`);
}

async function resolveAgentId(copilotToken: string, botId: string): Promise<string | null> {
  // Use GetGptList to find the full agent ID (includes metaOSSharedServicesTitleId)
  const claims = decodeJwt(copilotToken);
  const url = `https://substrate.office.com/m365Copilot//GetGptList?request=${encodeURIComponent(JSON.stringify({
    optionsSets: ["flux_gpt_data_retriever_enterprise"],
    traceId: "",
  }))}`;

  const res = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${copilotToken}`,
      "Origin": "https://m365.cloud.microsoft",
    },
  });

  if (!res.ok) {
    log.error(`GetGptList failed: ${res.status}`);
    return null;
  }

  const data = await res.json();
  for (const gpt of data.gptList || []) {
    // Match by botId in the gptId string
    if (gpt.gptId?.includes(botId)) {
      log.info(`Found agent in GPT list: ${gpt.name} → ${gpt.gptId}`);
      return gpt.gptId;
    }
  }
  return null;
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

  // Need PowerPlatform token
  const ppToken = await getTokenForScope(POWERPLATFORM_SCOPES);
  if (!ppToken) {
    log.info("No PowerPlatform token available — skipping agent creation");
    return null;
  }

  // Need M365 Copilot token for resolving the agent ID
  const copilotToken = await getToken();
  const claims = decodeJwt(copilotToken);
  const envUrl = getEnvironmentUrl(claims.tid);

  try {
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

      // Update with instructions
      await updateBotInstructions(envUrl, ppToken, botId, created.componentId);
      log.info("Agent instructions set");
    }

    // Resolve the full agent ID via GetGptList
    // The agent may take a moment to appear, so retry a few times
    let agentId: string | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      agentId = await resolveAgentId(copilotToken, botId);
      if (agentId) break;
      log.info(`Agent not yet in GPT list, waiting... (attempt ${attempt + 1}/3)`);
      await new Promise((r) => setTimeout(r, 5000));
    }

    if (!agentId) {
      // Fallback: construct the ID using the pattern T_{teamsAppTitleId}.{botId}.gpt.default
      // We can't know the teamsAppTitleId without GetGptList, so just skip
      log.error("Could not resolve agent ID from GPT list. Agent may need time to propagate.");
      return null;
    }

    // Cache it
    saveCachedAgent({ agentId, botId, createdAt: new Date().toISOString() });
    return agentId;
  } catch (err: any) {
    log.error("Agent creation failed:", err.message);
    return null;
  }
}
