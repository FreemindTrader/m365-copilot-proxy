import { describe, it, expect, beforeAll } from "vitest";
import {
  formatMessages,
  formatToolDefinitions,
  parseToolCalls,
  TOOL_CALL_FENCE,
  TOOL_CALL_FENCE_CLOSE,
} from "./index.js";
import { copilotChat, getToken } from "@opencode-m365/core";

// --- Sample tools mimicking what opencode sends ---

const SAMPLE_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "Read a file from the filesystem",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path to the file" },
        },
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
        properties: {
          path: { type: "string", description: "Absolute path to the directory" },
        },
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
        properties: {
          command: { type: "string", description: "The command to run" },
        },
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

// --- Unit tests for formatting/parsing (no network) ---

describe("parseToolCalls", () => {
  it("parses a single tool call", () => {
    const text = `${TOOL_CALL_FENCE}
{"name": "read_file", "arguments": {"path": "/foo/bar.ts"}}
${TOOL_CALL_FENCE_CLOSE}`;
    const result = parseToolCalls(text);
    expect(result.hasToolCalls).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe("read_file");
    expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual({ path: "/foo/bar.ts" });
  });

  it("parses multiple tool calls", () => {
    const text = `${TOOL_CALL_FENCE}
{"name": "read_file", "arguments": {"path": "/a.ts"}}
${TOOL_CALL_FENCE_CLOSE}

${TOOL_CALL_FENCE}
{"name": "list_directory", "arguments": {"path": "/src"}}
${TOOL_CALL_FENCE_CLOSE}`;
    const result = parseToolCalls(text);
    expect(result.hasToolCalls).toBe(true);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].function.name).toBe("read_file");
    expect(result.toolCalls[1].function.name).toBe("list_directory");
  });

  it("returns no tool calls for plain text", () => {
    const result = parseToolCalls("Hello, I can help you with that!");
    expect(result.hasToolCalls).toBe(false);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.textContent).toBe("Hello, I can help you with that!");
  });

  it("handles malformed JSON inside tool_call fence", () => {
    const text = `${TOOL_CALL_FENCE}
{not valid json}
${TOOL_CALL_FENCE_CLOSE}`;
    const result = parseToolCalls(text);
    expect(result.hasToolCalls).toBe(false);
  });
});

describe("formatToolDefinitions", () => {
  it("renders compact tool list", () => {
    const result = formatToolDefinitions(SAMPLE_TOOLS);
    expect(result).toContain("read_file(");
    expect(result).toContain("list_directory(");
    expect(result).toContain("bash(");
    expect(result).toContain("tool_call");
    expect(result).toContain("OUTPUT FORMAT — MANDATORY");
  });

  it("includes tool-to-action mapping rules", () => {
    const result = formatToolDefinitions(SAMPLE_TOOLS);
    expect(result).toContain("→ call read_file");
    expect(result).toContain("→ call bash");
  });
});

describe("formatMessages", () => {
  it("includes tool definitions when tools are provided", () => {
    const result = formatMessages(
      [{ role: "user", content: "list the files" }],
      SAMPLE_TOOLS,
    );
    expect(result).toContain("read_file(");
    expect(result).toContain("[user]\nlist the files");
  });

  it("skips tool definitions when tool_choice is none", () => {
    const result = formatMessages(
      [{ role: "user", content: "hello" }],
      SAMPLE_TOOLS,
      "none",
    );
    expect(result).not.toContain("read_file(");
  });

  it("renders tool result messages", () => {
    const result = formatMessages([
      { role: "user", content: "read package.json" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_123",
          type: "function" as const,
          function: { name: "read_file", arguments: '{"path": "/package.json"}' },
        }],
      },
      {
        role: "tool",
        content: '{"name": "my-package"}',
        tool_call_id: "call_123",
        name: "read_file",
      },
    ], SAMPLE_TOOLS);
    expect(result).toContain("[tool result for read_file (call_123)]");
    expect(result).toContain('{"name": "my-package"}');
  });
});

// --- Integration tests against real M365 Copilot ---
// These require valid auth credentials in ~/.config/opencode-m365/secrets.json

// Models to test (deduplicated — skip aliases that map to same tone)
const MODELS_TO_TEST = [
  "m365-copilot",     // magic (auto)
  "quick",            // Gpt_Quick
  "think-deeper",     // Gpt_Reasoning
  "gpt-5.4-quick",    // Gpt_5_4_Quick
  "gpt-5.4",          // Gpt_5_4_Reasoning
  "gpt-5.3",          // Gpt_5_3_Quick
  "gpt-5.3-think-deeper", // Gpt_5_3_Reasoning
  "gpt-5.2",          // Gpt_5_2_Quick
  "gpt-5.2-think-deeper", // Gpt_5_2_Reasoning
];

describe("M365 Copilot tool calling (live)", () => {
  let token: string;

  beforeAll(async () => {
    token = await getToken();
  }, 30000);

  async function sendToolPrompt(
    userMessage: string,
    model: string = "m365-copilot",
  ): Promise<{ fullText: string; parsed: ReturnType<typeof parseToolCalls> }> {
    const prompt = formatMessages(
      [
        { role: "system", content: "You are a coding agent. Follow tool calling instructions exactly." },
        { role: "user", content: userMessage },
      ],
      SAMPLE_TOOLS,
    );

    const stream = await copilotChat(token, prompt, model);
    let fullText = "";
    for await (const delta of stream) fullText += delta;
    if (stream.fullText) fullText = stream.fullText;

    const parsed = parseToolCalls(fullText);
    return { fullText, parsed };
  }

  // Single-model tests (default model)
  it("should call read_file when asked to read a file", async () => {
    const { fullText, parsed } = await sendToolPrompt(
      "Read the file /home/cramt/code/opencode-m365/package.json",
    );

    console.log("--- Response ---");
    console.log(fullText);
    console.log("--- Parsed ---");
    console.log(JSON.stringify(parsed, null, 2));

    expect(parsed.hasToolCalls).toBe(true);
    expect(parsed.toolCalls.length).toBeGreaterThanOrEqual(1);
    const readCall = parsed.toolCalls.find(tc => tc.function.name === "read_file");
    expect(readCall).toBeDefined();
  }, 120000);

  it("should respond with plain text for a simple question", async () => {
    const { fullText, parsed } = await sendToolPrompt(
      "What is TypeScript?",
    );

    console.log("--- Response ---");
    console.log(fullText.slice(0, 300));

    expect(parsed.hasToolCalls).toBe(false);
    expect(fullText.length).toBeGreaterThan(10);
  }, 120000);

  // Cross-model comparison
  describe.each(MODELS_TO_TEST)("model: %s", (model) => {
    it("should call a tool when asked to read a file", async () => {
      const { fullText, parsed } = await sendToolPrompt(
        "Read the file /home/cramt/code/opencode-m365/package.json",
        model,
      );

      console.log(`[${model}] read_file test`);
      console.log(`  Response (${fullText.length} chars): ${fullText.slice(0, 200)}`);
      console.log(`  Tool calls: ${parsed.toolCalls.map(tc => tc.function.name).join(", ") || "NONE"}`);

      expect(parsed.hasToolCalls).toBe(true);
    }, 120000);

    it("should call a tool when asked to list files", async () => {
      const { fullText, parsed } = await sendToolPrompt(
        "What files are in /home/cramt/code/opencode-m365?",
        model,
      );

      console.log(`[${model}] list_directory test`);
      console.log(`  Response (${fullText.length} chars): ${fullText.slice(0, 200)}`);
      console.log(`  Tool calls: ${parsed.toolCalls.map(tc => tc.function.name).join(", ") || "NONE"}`);

      expect(parsed.hasToolCalls).toBe(true);
    }, 120000);

    it("should call bash when asked to run a command", async () => {
      const { fullText, parsed } = await sendToolPrompt(
        "Run `ls -la` in /home/cramt/code/opencode-m365",
        model,
      );

      console.log(`[${model}] bash test`);
      console.log(`  Response (${fullText.length} chars): ${fullText.slice(0, 200)}`);
      console.log(`  Tool calls: ${parsed.toolCalls.map(tc => tc.function.name).join(", ") || "NONE"}`);

      expect(parsed.hasToolCalls).toBe(true);
    }, 120000);

    it("should NOT call tools for a plain question", async () => {
      const { fullText, parsed } = await sendToolPrompt(
        "Explain what a monorepo is in one sentence.",
        model,
      );

      console.log(`[${model}] plain text test`);
      console.log(`  Response (${fullText.length} chars): ${fullText.slice(0, 200)}`);
      console.log(`  Tool calls: ${parsed.toolCalls.map(tc => tc.function.name).join(", ") || "NONE"}`);

      expect(parsed.hasToolCalls).toBe(false);
    }, 120000);
  });
});
