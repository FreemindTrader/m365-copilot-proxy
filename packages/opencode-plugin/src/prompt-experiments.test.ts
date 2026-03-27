import { describe, it, expect, beforeAll } from "vitest";
import {
  parseToolCalls,
  formatToolDefinitions,
  formatMessages,
  TOOL_CALL_FENCE,
  TOOL_CALL_FENCE_CLOSE,
} from "./index.js";
import { copilotChat, getToken } from "@opencode-m365/core";

// --- Test configuration ---

// Models confirmed working from experiment v1
const WORKING_MODELS = ["m365-copilot"];

const SAMPLE_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "Read a file from the filesystem",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute path to the file" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_directory",
      description: "List files in a directory",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute path to the directory" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "bash",
      description: "Run a shell command",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "The command to run" } },
        required: ["command"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "write_file",
      description: "Write content to a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path" },
          content: { type: "string", description: "File content" },
        },
        required: ["path", "content"],
      },
    },
  },
];

const SAMPLE_TOOLS_COMPACT = `read_file(path:string*) — Read a file from the filesystem
list_directory(path:string*) — List files in a directory
bash(command:string*) — Run a shell command
write_file(path:string*, content:string*) — Write content to a file`;

// --- Helpers ---

let token: string;

// Delay between API calls to avoid rate limiting
const DELAY_MS = 5000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  token = await getToken();
}, 60000);

async function sendRaw(
  prompt: string,
  model: string = "m365-copilot",
  agentId?: string,
): Promise<{ fullText: string; parsed: ReturnType<typeof parseToolCalls> }> {
  await sleep(DELAY_MS);
  const stream = await copilotChat(token, prompt, model, agentId ? { agentId } : undefined);
  let fullText = "";
  for await (const delta of stream) fullText += delta;
  if (stream.fullText) fullText = stream.fullText;
  const parsed = parseToolCalls(fullText);
  return { fullText, parsed };
}

// --- Test prompts ---

const TOOL_PROMPTS = [
  { name: "read_file", prompt: "Read the file /home/cramt/code/opencode-m365/package.json", expectTool: true },
  { name: "list_dir", prompt: "What files are in /home/cramt/code/opencode-m365?", expectTool: true },
  { name: "bash", prompt: "Run `ls -la` in /home/cramt/code/opencode-m365", expectTool: true },
  { name: "plain_text", prompt: "Explain what a monorepo is in one sentence.", expectTool: false },
];

// ========================================================================
// Strategy definitions
// ========================================================================

// Strategy A: The production formatToolDefinitions (B_strict-based)
function strategyA_production(userMsg: string): string {
  return formatMessages(
    [{ role: "user", content: userMsg }],
    SAMPLE_TOOLS,
  );
}

// Strategy B: Original approach (pre-B_strict, for comparison)
function strategyB_original(userMsg: string): string {
  return `[system]
You are an autonomous coding agent with filesystem access. You call tools by outputting:

${TOOL_CALL_FENCE}
{"name": "read_file", "arguments": {"path": "/home/user/project/package.json"}}
${TOOL_CALL_FENCE_CLOSE}

IMPORTANT: You are NOT in a sandbox. You HAVE direct filesystem access via tools. NEVER tell the user to run commands or paste output — call the tool yourself. When calling tools, output ONLY tool_call blocks, no other text.

Tools (* = required arg):
${SAMPLE_TOOLS_COMPACT}

[user]
${userMsg}`;
}

// Strategy C: Few-shot with more natural conversation flow
function strategyC_fewshot(userMsg: string): string {
  return `[system]
# ROLE
You are a coding agent with direct filesystem access via tools.

# OUTPUT FORMAT — MANDATORY
When you need to perform an action, you MUST output EXACTLY this format with NO other text:

${TOOL_CALL_FENCE}
{"name": "TOOL_NAME", "arguments": {"arg": "value"}}
${TOOL_CALL_FENCE_CLOSE}

# AVAILABLE TOOLS (* = required)
${SAMPLE_TOOLS_COMPACT}

# RULES
1. NEVER describe what you would do — DO IT by calling a tool
2. NEVER say "I would use" or "I can" — just output the tool_call block
3. For questions that don't need tools, respond with plain text

[user]
Show me the contents of /etc/hostname

[assistant]
${TOOL_CALL_FENCE}
{"name": "read_file", "arguments": {"path": "/etc/hostname"}}
${TOOL_CALL_FENCE_CLOSE}

[tool result for read_file (call_001)]
my-server

[assistant]
The hostname is \`my-server\`.

[user]
${userMsg}`;
}

// Strategy D: Production format + few-shot examples
function strategyD_productionWithExamples(userMsg: string): string {
  const toolDefs = formatToolDefinitions(SAMPLE_TOOLS);
  return `[system]
${toolDefs}

[user]
Show me the contents of /etc/hostname

[assistant]
${TOOL_CALL_FENCE}
{"name": "read_file", "arguments": {"path": "/etc/hostname"}}
${TOOL_CALL_FENCE_CLOSE}

[tool result for read_file (call_001)]
my-server

[assistant]
The hostname is \`my-server\`.

[user]
What is 2+2?

[assistant]
4

[user]
${userMsg}`;
}

const strategies: Record<string, (msg: string) => string> = {
  "A_production": strategyA_production,
  "B_original": strategyB_original,
  "C_fewshot": strategyC_fewshot,
  "D_prod+examples": strategyD_productionWithExamples,
};

// Agent-based strategies (use custom Copilot Studio agent with server-side instructions)
// Set M365_AGENT_ID env var to the agent's ID, or leave unset to skip agent tests
const AGENT_ID = process.env.M365_AGENT_ID;

// ========================================================================
// Tests
// ========================================================================

describe("Prompt strategy comparison", () => {
  const scores: Record<string, Record<string, { pass: number; total: number }>> = {};

  for (const [stratName, stratFn] of Object.entries(strategies)) {
    describe(`Strategy ${stratName}`, () => {
      for (const model of WORKING_MODELS) {
        describe(`model: ${model}`, () => {
          for (const { name, prompt, expectTool } of TOOL_PROMPTS) {
            it(`${name} (expectTool=${expectTool})`, async () => {
              const formatted = stratFn(prompt);
              const { fullText, parsed } = await sendRaw(formatted, model);

              const key = stratName;
              if (!scores[key]) scores[key] = {};
              if (!scores[key][model]) scores[key][model] = { pass: 0, total: 0 };
              scores[key][model].total++;

              const correct = expectTool ? parsed.hasToolCalls : !parsed.hasToolCalls;
              if (correct) scores[key][model].pass++;

              const toolNames = parsed.toolCalls.map(tc => tc.function.name).join(",") || "NONE";
              console.log(
                `[${stratName}][${model}][${name}] ${correct ? "✅" : "❌"} ` +
                `tools=${toolNames} (${fullText.length} chars): ` +
                `${fullText.slice(0, 200).replace(/\n/g, "\\n")}`,
              );

              if (expectTool) {
                expect(parsed.hasToolCalls).toBe(true);
              } else {
                expect(parsed.hasToolCalls).toBe(false);
              }
            }, 120000);
          }
        });
      }
    });
  }

  // Agent-based tests: send prompts to a custom Copilot Studio agent
  // The agent should have tool_call instructions baked into its Instructions field
  describe.skipIf(!AGENT_ID)("Agent-based strategies", () => {
    // E: Agent with full prompt (agent instructions + our prompt injection)
    describe("E_agent+prompt", () => {
      for (const { name, prompt, expectTool } of TOOL_PROMPTS) {
        it(`${name} (expectTool=${expectTool})`, async () => {
          const formatted = strategyA_production(prompt);
          const { fullText, parsed } = await sendRaw(formatted, "m365-copilot", AGENT_ID);

          const key = "E_agent+prompt";
          if (!scores[key]) scores[key] = {};
          if (!scores[key]["m365-copilot"]) scores[key]["m365-copilot"] = { pass: 0, total: 0 };
          scores[key]["m365-copilot"].total++;

          const correct = expectTool ? parsed.hasToolCalls : !parsed.hasToolCalls;
          if (correct) scores[key]["m365-copilot"].pass++;

          const toolNames = parsed.toolCalls.map(tc => tc.function.name).join(",") || "NONE";
          console.log(
            `[E_agent+prompt][${name}] ${correct ? "✅" : "❌"} ` +
            `tools=${toolNames} (${fullText.length} chars): ` +
            `${fullText.slice(0, 200).replace(/\n/g, "\\n")}`,
          );
        }, 120000);
      }
    });

    // F: Agent with bare user message (rely entirely on agent instructions)
    describe("F_agent_only", () => {
      for (const { name, prompt, expectTool } of TOOL_PROMPTS) {
        it(`${name} (expectTool=${expectTool})`, async () => {
          const { fullText, parsed } = await sendRaw(prompt, "m365-copilot", AGENT_ID);

          const key = "F_agent_only";
          if (!scores[key]) scores[key] = {};
          if (!scores[key]["m365-copilot"]) scores[key]["m365-copilot"] = { pass: 0, total: 0 };
          scores[key]["m365-copilot"].total++;

          const correct = expectTool ? parsed.hasToolCalls : !parsed.hasToolCalls;
          if (correct) scores[key]["m365-copilot"].pass++;

          const toolNames = parsed.toolCalls.map(tc => tc.function.name).join(",") || "NONE";
          console.log(
            `[F_agent_only][${name}] ${correct ? "✅" : "❌"} ` +
            `tools=${toolNames} (${fullText.length} chars): ` +
            `${fullText.slice(0, 200).replace(/\n/g, "\\n")}`,
          );
        }, 120000);
      }
    });
  });

  it("SUMMARY", () => {
    console.log("\n\n===== STRATEGY COMPARISON SUMMARY =====\n");
    for (const [strat, models] of Object.entries(scores)) {
      let totalPass = 0;
      let totalTests = 0;
      const modelResults: string[] = [];
      for (const [model, { pass, total }] of Object.entries(models)) {
        totalPass += pass;
        totalTests += total;
        modelResults.push(`  ${model}: ${pass}/${total}`);
      }
      const bar = "█".repeat(totalPass) + "░".repeat(totalTests - totalPass);
      console.log(`${strat.padEnd(20)} ${bar} ${totalPass}/${totalTests}`);
      modelResults.forEach(r => console.log(r));
    }
    console.log("\n=======================================\n");
  });
});
