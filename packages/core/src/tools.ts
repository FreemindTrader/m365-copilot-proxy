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

// M365 invents bookkeeping objects ({"confidence": 0.5}) and wraps its answer in
// {"final": "..."} — neither is a real tool call. Strip confidence everywhere;
// drop final when it rides alongside tool calls (it's usually a premature
// success claim), and unwrap it when it stands alone as the response.
const CONFIDENCE_REGEX = /\{\s*"confidence"\s*:\s*-?[0-9.]+\s*\}/g;
const FINAL_OBJECT_REGEX = /\{\s*"final"\s*:\s*"(?:[^"\\]|\\.)*"\s*\}/g;

/** Strip invented confidence/final objects from a no-tool-call response and
 *  unwrap a lone {"final": "..."} answer into bare text. Returns null if empty. */
function cleanLooseText(text: string): string | null {
  let out = text;
  for (const m of out.match(FINAL_OBJECT_REGEX) ?? []) {
    try {
      const value = JSON.parse(m).final;
      if (typeof value === "string") out = out.replace(m, value);
    } catch {
      // leave the literal text in place if it isn't valid JSON
    }
  }
  out = out.replace(CONFIDENCE_REGEX, "").trim();
  return out.length ? out : null;
}

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

  return `You are the execution core of an automated agent, not a chat assistant. Your output is parsed by a program — a real runtime that executes your tool calls against a live system and returns the actual results to you in <tool_response> blocks.

Performing the task with tools is your PRIMARY JOB. Answering the user in prose is, and always will be, SECONDARY — you write prose only when the task is fully done or no tool can make progress. Default to acting, not talking.

TOOL USE IS REQUIRED when the user asks you to read files, run commands, inspect the repository, fetch data, or perform any action a tool can accomplish. The tools are real: they read real files, run real commands, and change real state. Never answer from memory or simulate a result when a tool can provide it.

When calling a tool, output ONLY a single JSON tool call. No other text:
{"tool": "<tool_name>", "arguments": { ... }}

STRICT RULES:
- Output ONLY the JSON object when calling a tool. No markdown, no code fences, no explanation, no surrounding text, and no JSON keys other than "tool" and "arguments" (never "confidence", "final", "thoughts", etc.).
- Never describe your intent ("I'll read the file…", "Let me check…") and never emit filler or acknowledgements ("Good, that's fixable", "You're absolutely right", "This one:"). Each turn is exactly one tool call OR the final answer — nothing in between.
- One tool call per response, then stop and wait for its <tool_response>. Never batch multiple calls in one response.
- Tool names and argument keys must match exactly as defined below.
- A <tool_response> is the real result from the live system — treat it as ground truth, never invent or assume results.
- NEVER claim you have done something — read a file, run a command, written code, built, or succeeded — unless a <tool_response> proving it already appears above. Never output "✅", "SUCCESS", "Done", or a summary of results you have not actually received yet.
- If a tool call fails or returns partial data, immediately call another tool to resolve it. Do not give up.
- Do not defer work or promise future results ("I'll do this next…").
- Do not ask the user questions unless tool execution is impossible.
- Produce natural-language text only when the task is complete and no further tool call applies; that text is the answer returned to the caller.
- When you do give that final answer, output only the answer itself — no preamble ("All right…", "Here's a summary…", "Let me…"), no sign-off, and no "let's close the loop."

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

/**
 * A few-shot that demonstrates the sustained one-call-per-turn loop — act, wait
 * for the REAL result, act again using it, then a terse preamble-free answer.
 * Built from the CLIENT'S ACTUAL tools so the model never sees a phantom tool:
 * a hard-coded `read_file` (absent from pi's `read`/`bash`/`edit`/`write` set)
 * derailed reasoning models into critiquing the example instead of acting. Uses
 * concrete values, never `…`/`<placeholder>` (reasoning models echo those).
 */
function fewShotExample(tools: ToolDef[]): string[] {
  const find = (re: RegExp) => tools.find((t) => re.test(t.function.name));
  const firstKey = (t: ToolDef, fallback: string) =>
    t.function.parameters?.required?.[0] ??
    Object.keys(t.function.parameters?.properties ?? {})[0] ??
    fallback;

  const act = find(/bash|shell|run|exec|command|terminal/i) ?? find(/write|edit|create/i);
  const read = find(/read|cat|view|open|show|get|fetch|file/i);

  if (act && read && act !== read) {
    const ak = firstKey(act, "command");
    const rk = firstKey(read, "path");
    return [
      `<user>\nAppend "build: ok" to /tmp/status and confirm it's there.\n</user>`,
      `<assistant>\n{"tool": "${act.function.name}", "arguments": {"${ak}": "echo 'build: ok' >> /tmp/status"}}\n</assistant>`,
      `<tool_response name="${act.function.name}" call_id="ex1">\n</tool_response>`,
      `<assistant>\n{"tool": "${read.function.name}", "arguments": {"${rk}": "/tmp/status"}}\n</assistant>`,
      `<tool_response name="${read.function.name}" call_id="ex2">\nbuild: ok\n</tool_response>`,
      `<assistant>\nConfirmed — /tmp/status contains "build: ok".\n</assistant>`,
    ];
  }

  // Single-tool fallback: one clean real call against a concrete input.
  const t = read ?? act ?? tools[0];
  const k = firstKey(t, "path");
  return [
    `<user>\nWhat's the hostname of this machine?\n</user>`,
    `<assistant>\n{"tool": "${t.function.name}", "arguments": {"${k}": "/etc/hostname"}}\n</assistant>`,
    `<tool_response name="${t.function.name}" call_id="ex1">\nweb-prod-01\n</tool_response>`,
    `<assistant>\nThe hostname is web-prod-01.\n</assistant>`,
  ];
}

/**
 * Inject a synthetic `reply(text)` tool that the model calls instead of
 * answering in prose. Wired by the handler (which converts `reply` back to a
 * plain assistant message), so it's invisible to the client. Off by default —
 * set `M365_INJECT_REPLY_TOOL=1` to enable.
 *
 * Why this matters: M365 mostly disobeys "only emit JSON" when the right
 * answer is text. Routing text through a `reply()` call makes EVERY turn a
 * tool call, which is a much cleaner contract for the model to follow.
 *
 * Tradeoff: adds 1 tool to the prompt, which nudges the Disengaged-filter
 * threshold a tiny bit. Safe with lean toolsets (<= ~10 tools).
 */
function maybeInjectReplyTool(tools: ToolDef[]): ToolDef[] {
  if (!process.env.M365_INJECT_REPLY_TOOL) return tools;
  if (tools.some((t) => t.function.name === "reply")) return tools;
  const replyTool: ToolDef = {
    type: "function",
    function: {
      name: "reply",
      description:
        "Send a plain-text answer to the user. Use this whenever you would otherwise reply in prose.",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "The text to send" } },
        required: ["text"],
      },
    },
  };
  return [replyTool, ...tools];
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

  const effectiveTools = tools ? maybeInjectReplyTool(tools) : tools;
  if (effectiveTools && effectiveTools.length > 0 && toolChoice !== "none") {
    parts.push(`<system>\n${formatToolDefinitions(effectiveTools)}${formatToolChoiceInstruction(toolChoice)}\n</system>`);

    // Few-shot built from the client's real tools (see fewShotExample). No
    // chit-chat example (taught prose answers), no batching (taught plan-dumps).
    //
    // Measured useless: the `no_fewshot` variant of
    // `scripts/tool-compliance-experiment.mjs` (June 2026) hit 5/5 compliance
    // AND was the fastest variant — the agent's server-side system prompt
    // alone is doing the work, the few-shot just spends tokens for no win.
    // Off by default; set `M365_KEEP_FEWSHOT=1` to restore if a future M365
    // change makes it useful again.
    if (process.env.M365_KEEP_FEWSHOT) {
      parts.push(...fewShotExample(effectiveTools));
    }
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
    return { hasToolCalls: false, toolCalls: [], textContent: cleanLooseText(text) };
  }

  // Strip matched tool calls from text to get remaining content.
  // M365 is a markdown model and often wraps the JSON in a ```json / ```tool_call
  // fence even when told not to; remove the now-empty fence markers it leaves
  // behind so they aren't mistaken for real assistant prose. Also drop the
  // invented confidence/final objects so a premature "✅ SUCCESS" never reaches
  // the client and a junk-only leftover isn't flagged as mixed output.
  let remaining = text
    .replace(jsonRegex, "")
    .replace(new RegExp(FENCED_TOOL_CALL_REGEX.source, "g"), "")
    .replace(CONFIDENCE_REGEX, "")
    .replace(FINAL_OBJECT_REGEX, "")
    .replace(/```(?:json|tool_call)?\s*```/g, "") // empty fence pair
    .replace(/```(?:json|tool_call)?/g, "") // dangling opening/closing fence
    .trim();

  return {
    hasToolCalls: true,
    toolCalls,
    textContent: remaining || null,
  };
}
