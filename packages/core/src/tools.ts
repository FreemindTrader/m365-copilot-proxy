import { createLogger } from "./log.js";

const log = createLogger("tools");

// --- Types (standalone, no zod dependency) ---

export interface ToolFunction {
  name: string;
  description?: string;
  parameters?: {
    properties?: Record<string, { type?: string; [k: string]: unknown }>;
    required?: string[];
    [k: string]: unknown;
  };
}

export interface ToolDef {
  type?: string;
  function: ToolFunction;
}

export interface Message {
  role: string;
  content?: string | Array<{ type: string; text?: string }> | null;
  tool_calls?: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } }
  | undefined;

// --- Tool call format ---

// The model outputs JSON tool calls; we parse them from the raw text.
// The agent system prompt tells the model to use {"tool": "...", "arguments": {...}}
const TOOL_CALL_REGEX = /\{\s*"tool"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{[\s\S]*?\}\s*\}/g;

// Legacy fence format — still supported for parsing
const FENCED_TOOL_CALL_REGEX = /```tool_call\s*\n(\{[\s\S]*?\})\s*\n\s*```/g;

// --- Formatting ---

export function formatToolDefinitions(tools: ToolDef[]): string {
  const defs = tools.map((t) => {
    const f = t.function;
    const schema: Record<string, unknown> = {
      name: f.name,
    };
    if (f.description) schema.description = f.description;
    if (f.parameters) schema.parameters = f.parameters;
    return JSON.stringify(schema, null, 2);
  }).join("\n\n");

  return `You are an AI assistant with access to tools.

TOOL USE IS REQUIRED when the user asks you to read files, run commands, inspect the repository, fetch data, or perform any action that a tool can accomplish. Never answer from memory when a tool can provide the answer.

When calling a tool, output ONLY a single JSON tool call. No other text:
{"tool": "<tool_name>", "arguments": { ... }}

STRICT RULES:
- Output ONLY the JSON object when calling a tool. No markdown, no explanation, no surrounding text.
- Never describe your intent ("I'll read the file…", "Let me check…"). Just call the tool.
- One tool call per response. Never combine a tool call with explanatory text.
- Tool names and argument keys must match exactly as defined below.
- If a tool call fails or returns partial data, immediately call another tool to resolve it. Do not give up.
- Do not defer work or promise future results ("I'll do this next…").
- Do not ask the user questions unless tool execution is impossible.
- If no tool is needed, respond normally with natural language.

<tools>
${defs}
</tools>`;
}

export function formatToolChoiceInstruction(toolChoice: ToolChoice): string {
  if (!toolChoice || toolChoice === "auto") return "";
  if (toolChoice === "none") return "\nDo NOT call tools. Text only.";
  if (toolChoice === "required") return "\nYou MUST call at least one tool.";
  if (typeof toolChoice === "object" && toolChoice.function) {
    return `\nYou MUST call "${toolChoice.function.name}".`;
  }
  return "";
}

export function getMessageContent(msg: Message): string {
  if (msg.content === null || msg.content === undefined) return "";
  if (typeof msg.content === "string") return msg.content;
  return msg.content.map((p) => p.text || "").join("");
}

export function formatMessages(
  messages: Message[],
  tools?: ToolDef[],
  toolChoice?: ToolChoice,
  conversationId?: string,
): string {
  const parts: string[] = [];

  if (conversationId) {
    parts.push(`<conversation_id>${conversationId}</conversation_id>`);
  }

  if (tools && tools.length > 0 && toolChoice !== "none") {
    parts.push(`<system>\n${formatToolDefinitions(tools)}${formatToolChoiceInstruction(toolChoice)}\n</system>`);

    // Few-shot examples to override M365 Copilot's built-in behavior
    parts.push(`<user>\nShow me the contents of /etc/hostname\n</user>`);
    parts.push(`<assistant>\n{"tool": "read_file", "arguments": {"path": "/etc/hostname"}}\n</assistant>`);
    parts.push(`<tool_response name="read_file" call_id="ex1">\nmy-server\n</tool_response>`);
    parts.push(`<assistant>\nThe hostname is my-server.\n</assistant>`);
    parts.push(`<user>\nWhat is 2+2?\n</user>`);
    parts.push(`<assistant>\n4\n</assistant>`);
  }

  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      const calls = m.tool_calls.map((tc) => {
        const args = typeof tc.function.arguments === "string"
          ? tc.function.arguments
          : JSON.stringify(tc.function.arguments);
        return `{"tool": "${tc.function.name}", "arguments": ${args}}`;
      }).join("\n");
      const content = getMessageContent(m);
      parts.push(`<assistant>${content ? "\n" + content : ""}\n${calls}\n</assistant>`);
    } else if (m.role === "tool") {
      const name = m.name || "unknown";
      const callId = m.tool_call_id || "?";
      parts.push(`<tool_response name="${name}" call_id="${callId}">\n${getMessageContent(m)}\n</tool_response>`);
    } else {
      parts.push(`<${m.role}>\n${getMessageContent(m)}\n</${m.role}>`);
    }
  }

  return parts.join("\n\n");
}

// --- Parsing ---

export interface ParsedToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ParseResult {
  hasToolCalls: boolean;
  toolCalls: ParsedToolCall[];
  textContent: string | null;
}

export function parseToolCalls(text: string): ParseResult {
  const toolCalls: ParsedToolCall[] = [];

  // Try JSON format first: {"tool": "...", "arguments": {...}}
  const jsonRegex = new RegExp(TOOL_CALL_REGEX.source, "g");
  let match: RegExpExecArray | null;

  while ((match = jsonRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[0]);
      const name = parsed.tool;
      if (name) {
        toolCalls.push({
          id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
          type: "function",
          function: {
            name,
            arguments: typeof parsed.arguments === "string"
              ? parsed.arguments
              : JSON.stringify(parsed.arguments ?? {}),
          },
        });
      }
    } catch {
      log.error("Failed to parse tool call JSON:", match[0]);
    }
  }

  // Fallback: try legacy fenced format
  if (toolCalls.length === 0) {
    const fencedRegex = new RegExp(FENCED_TOOL_CALL_REGEX.source, "g");
    while ((match = fencedRegex.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        const name = parsed.tool || parsed.name;
        if (name) {
          toolCalls.push({
            id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
            type: "function",
            function: {
              name,
              arguments: typeof parsed.arguments === "string"
                ? parsed.arguments
                : JSON.stringify(parsed.arguments ?? {}),
            },
          });
        }
      } catch {
        log.error("Failed to parse fenced tool call JSON:", match[1]);
      }
    }
  }

  if (toolCalls.length === 0) {
    return { hasToolCalls: false, toolCalls: [], textContent: text };
  }

  // Strip matched tool calls from text to get remaining content
  let remaining = text
    .replace(jsonRegex, "")
    .replace(new RegExp(FENCED_TOOL_CALL_REGEX.source, "g"), "")
    .trim();

  return {
    hasToolCalls: true,
    toolCalls,
    textContent: remaining || null,
  };
}
