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
{"name": "bash", "arguments": {"command": "ls"}}
${TOOL_CALL_FENCE_CLOSE}`;
    const result = parseToolCalls(text);
    expect(result.hasToolCalls).toBe(true);
    expect(result.toolCalls).toHaveLength(2);
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
  it("renders compact tool list with rules", () => {
    const result = formatToolDefinitions(SAMPLE_TOOLS);
    expect(result).toContain("read_file(");
    expect(result).toContain("bash(");
    expect(result).toContain("tool_call");
    expect(result).toContain("OUTPUT FORMAT — MANDATORY");
    expect(result).toContain("→ call read_file");
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

// --- Integration test against real M365 Copilot ---
// Requires valid auth credentials in ~/.config/opencode-m365/secrets.json
// Only 2 API calls to avoid rate limiting

describe("M365 Copilot tool calling (live)", () => {
  let token: string;

  beforeAll(async () => {
    token = await getToken();
  }, 30000);

  it("should produce a valid response for a file read request", async () => {
    const prompt = formatMessages(
      [
        { role: "system", content: "You are a coding agent. Follow tool calling instructions exactly." },
        { role: "user", content: "Read the file /home/cramt/code/opencode-m365/package.json" },
      ],
      SAMPLE_TOOLS,
    );

    const stream = await copilotChat(token, prompt, "m365-copilot");
    let fullText = "";
    for await (const delta of stream) fullText += delta;
    if (stream.fullText) fullText = stream.fullText;

    const parsed = parseToolCalls(fullText);
    console.log("Tool call response:", fullText.slice(0, 300));

    // M365 is non-deterministic — tool call is expected but text is acceptable
    if (parsed.hasToolCalls) {
      expect(parsed.toolCalls[0].function.name).toBe("read_file");
    } else {
      expect(fullText.length).toBeGreaterThan(0);
    }
  }, 120000);

  it("should return plain text for a non-tool question", async () => {
    const prompt = formatMessages(
      [
        { role: "system", content: "You are a coding agent. Follow tool calling instructions exactly." },
        { role: "user", content: "What is TypeScript? One sentence." },
      ],
      SAMPLE_TOOLS,
    );

    const stream = await copilotChat(token, prompt, "m365-copilot");
    let fullText = "";
    for await (const delta of stream) fullText += delta;
    if (stream.fullText) fullText = stream.fullText;

    const parsed = parseToolCalls(fullText);
    console.log("Plain text response:", fullText.slice(0, 300));
    expect(parsed.hasToolCalls).toBe(false);
    expect(fullText.length).toBeGreaterThan(10);
  }, 120000);
});
