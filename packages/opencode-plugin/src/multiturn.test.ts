import { describe, it, expect, beforeAll } from "vitest";
import {
  parseToolCalls,
  formatMessages,
  TOOL_CALL_FENCE,
  TOOL_CALL_FENCE_CLOSE,
} from "./index.js";
import { copilotChat, getToken } from "@opencode-m365/core";
import type { z } from "zod/v4";
import type { ChatCompletionRequest } from "@opencode-m365/core";

type Message = z.infer<typeof ChatCompletionRequest>["messages"][number];

const TOOLS = [
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
];

let token: string;

beforeAll(async () => {
  token = await getToken();
}, 60000);

async function chat(messages: Message[]): Promise<{ fullText: string; parsed: ReturnType<typeof parseToolCalls> }> {
  const prompt = formatMessages(messages, TOOLS);
  console.log("--- PROMPT (last 500 chars) ---");
  console.log(prompt.slice(-500));
  console.log("--- END PROMPT ---\n");

  const stream = await copilotChat(token, prompt, "m365-copilot");
  let fullText = "";
  for await (const delta of stream) fullText += delta;
  if (stream.fullText) fullText = stream.fullText;
  const parsed = parseToolCalls(fullText);
  return { fullText, parsed };
}

// This test simulates the full opencode flow in just 2 API calls:
// 1. User asks to read a file → model should output tool_call
// 2. We feed back the tool result → model should summarize (no tool_call)
describe("Multi-turn tool calling", () => {
  it("complete read_file → result → summary flow", async () => {
    const messages: Message[] = [
      { role: "user", content: "Read the file /tmp/test-opencode.txt and tell me what's in it" },
    ];

    // Turn 1: expect a tool call
    console.log("=== TURN 1: User asks to read file ===");
    const turn1 = await chat(messages);
    console.log(`Turn 1 response (${turn1.fullText.length} chars):`);
    console.log(turn1.fullText.slice(0, 500));
    console.log(`Parsed: hasToolCalls=${turn1.parsed.hasToolCalls}, tools=${turn1.parsed.toolCalls.map(tc => tc.function.name).join(",")}`);
    console.log();

    expect(turn1.parsed.hasToolCalls).toBe(true);
    const toolCall = turn1.parsed.toolCalls[0];
    expect(toolCall.function.name).toBe("read_file");

    // Now simulate what opencode does: append the assistant's tool call + tool result
    messages.push({
      role: "assistant",
      content: turn1.parsed.textContent,
      tool_calls: turn1.parsed.toolCalls.map(tc => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
    });
    messages.push({
      role: "tool",
      content: "Hello from opencode! This is a test file.\nLine 2: it works!",
      tool_call_id: toolCall.id,
      name: "read_file",
    });

    // Turn 2: expect a text summary (no tool call)
    console.log("=== TURN 2: Tool result fed back, expect summary ===");
    const turn2 = await chat(messages);
    console.log(`Turn 2 response (${turn2.fullText.length} chars):`);
    console.log(turn2.fullText.slice(0, 500));
    console.log(`Parsed: hasToolCalls=${turn2.parsed.hasToolCalls}`);
    console.log();

    expect(turn2.parsed.hasToolCalls).toBe(false);
    expect(turn2.fullText.length).toBeGreaterThan(10);
    // The summary should mention something about the file content
    const lower = turn2.fullText.toLowerCase();
    expect(lower.includes("hello") || lower.includes("test") || lower.includes("opencode") || lower.includes("file")).toBe(true);

    console.log("=== MULTI-TURN TEST PASSED ===");
  }, 180000);
});
