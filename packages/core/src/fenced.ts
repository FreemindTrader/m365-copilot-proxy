import { createLogger } from "./log.js";
import type { ParsedToolCall, ToolDef } from "./tools.js";

const log = createLogger("fenced");

// --- Fenced tool-call format (M365_TOOL_FORMAT=fenced) ------------------------
//
// Hypothesis H4 (docs/hypotheses.md, experiment E-C1): M365's chat-tuned model
// emits a Markdown code fence — ```bash / ```write_file — far more readily than a
// `{"tool":...,"arguments":{...}}` JSON object, because fenced code is everywhere
// in its training data and (crucially) a multi-line file body needs no JSON string
// escaping. The 0/5 bench baseline (§8.12) is the model narrating success instead
// of acting; removing the escaping friction is the remaining untested lever.
//
// Format, per tool:
//   - fence info-string is the EXACT tool name
//   - scalar args render as `key: value` header lines
//   - one free-form "body" arg is the fence body (blank line separates it from the
//     header, like email/front-matter)
//   - an old/new edit pair renders as an aider-style SEARCH/REPLACE diff
//
//   ```bash
//   ls -la
//   ```
//
//   ```write_file
//   path: fizzbuzz.py
//
//   for i in range(1, 101):
//       print(i)
//   ```
//
//   ```edit_file
//   path: app.py
//   <<<<<<< SEARCH
//   debug = False
//   =======
//   debug = True
//   >>>>>>> REPLACE
//   ```
//
// Known limitation: a `write_file` body that itself contains a ``` fence can't be
// carried unambiguously — this is exactly where JSON wins, and the bench A/B will
// show whether the escaping-free win on ordinary files outweighs it.

const BODY_PARAM_NAMES = [
  "command", "content", "code", "body", "script", "text",
  "query", "input", "patch", "cmd", "data", "contents",
];
const SEARCH_KEYS = ["old", "search", "find", "old_str", "old_string", "target"];
const REPLACE_KEYS = ["new", "replace", "replacement", "new_str", "new_string"];

// Fence info-strings that mean "a shell script". M365's chat-tuned model emits
// ```bash blocks reflexively (it's the one agentic-shaped output Microsoft's
// system prompt permits); we route them to whatever shell tool the harness gave,
// whatever it's named. See docs/hypotheses.md §A (shell-routing).
const SHELL_LANGS = new Set([
  "bash", "sh", "shell", "zsh", "console", "shell-session", "shellsession", "shsession",
]);
// A tool counts as "the shell" if its name looks like a run-a-command tool. pi
// uses `bash`, opencode `bash`, hermes `shell`/`run`, openclaw `run_command` — all caught.
const SHELL_TOOL_NAME = /^(bash|sh|shell|zsh|run|exec|execute|command|cmd|terminal|run_command|run_terminal_cmd|execute_command|execute_bash|shell_exec|system)$/i;

/** The harness tool (if any) that runs a shell command — the target for ```bash routing. */
export function findShellTool(tools: ToolDef[]): ToolDef | undefined {
  return tools.find((t) => SHELL_TOOL_NAME.test(t.function.name)) ??
    // fallback: a single-string-param tool whose param is command-ish
    tools.find((t) => {
      const props = Object.keys(t.function.parameters?.properties ?? {});
      return props.length === 1 && /^(command|cmd|script|input)$/i.test(props[0]);
    });
}

export interface FencedToolSpec {
  name: string;
  description?: string;
  /** Scalar params rendered as `key: value` header lines. */
  headerParams: string[];
  /** The free-form param carried as the fence body (mutually exclusive with editPair). */
  bodyParam?: string;
  /** An (old → new) pair rendered as a SEARCH/REPLACE diff. */
  editPair?: { search: string; replace: string };
}

/** Derive how a single OpenAI tool maps onto the fenced shape. */
export function deriveFencedSpec(tool: ToolDef): FencedToolSpec {
  const name = tool.function.name;
  const description = tool.function.description;
  const props = Object.keys(tool.function.parameters?.properties ?? {});

  const search = props.find((p) => SEARCH_KEYS.includes(p));
  const replace = props.find((p) => REPLACE_KEYS.includes(p));
  if (search && replace) {
    return {
      name,
      description,
      editPair: { search, replace },
      headerParams: props.filter((p) => p !== search && p !== replace),
    };
  }

  const bodyParam =
    props.find((p) => BODY_PARAM_NAMES.includes(p)) ??
    (props.length === 1 ? props[0] : undefined);
  return {
    name,
    description,
    bodyParam,
    headerParams: props.filter((p) => p !== bodyParam),
  };
}

export function buildSpecMap(tools: ToolDef[]): Map<string, FencedToolSpec> {
  const m = new Map<string, FencedToolSpec>();
  for (const t of tools) m.set(t.function.name, deriveFencedSpec(t));

  // Shell aliasing: route the model's reflexive ```bash / ```sh / ```shell blocks
  // to the harness's shell tool even when it's named `run`/`run_command`/etc., so
  // the model can "just write bash" (the behavior M365 reliably permits) and the
  // harness still receives a structured tool_call under its own tool's name.
  const shell = findShellTool(tools);
  if (shell) {
    const shellSpec = m.get(shell.function.name)!;
    for (const lang of SHELL_LANGS) {
      if (!m.has(lang)) m.set(lang, shellSpec);
    }
  }
  return m;
}

function scalarToString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

/** Render one concrete tool call (name + args object) as a fenced block. */
export function renderFencedCall(spec: FencedToolSpec, args: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const h of spec.headerParams) {
    if (args[h] !== undefined) lines.push(`${h}: ${scalarToString(args[h])}`);
  }

  if (spec.editPair) {
    lines.push("<<<<<<< SEARCH");
    lines.push(scalarToString(args[spec.editPair.search]));
    lines.push("=======");
    lines.push(scalarToString(args[spec.editPair.replace]));
    lines.push(">>>>>>> REPLACE");
  } else if (spec.bodyParam !== undefined) {
    if (lines.length) lines.push(""); // blank line separates header from body
    lines.push(scalarToString(args[spec.bodyParam]));
  }

  return "```" + spec.name + "\n" + lines.join("\n") + "\n```";
}

/** A self-documenting template shown in the per-request <tools> block. */
function renderFencedTemplate(spec: FencedToolSpec): string {
  const lines: string[] = [];
  for (const h of spec.headerParams) lines.push(`${h}: <${h}>`);
  if (spec.editPair) {
    lines.push("<<<<<<< SEARCH");
    lines.push(`<${spec.editPair.search}>`);
    lines.push("=======");
    lines.push(`<${spec.editPair.replace}>`);
    lines.push(">>>>>>> REPLACE");
  } else if (spec.bodyParam !== undefined) {
    if (lines.length) lines.push("");
    lines.push(`<${spec.bodyParam}>`);
  }
  const header = spec.description ? `${spec.name} — ${spec.description}` : spec.name;
  return `${header}\n\`\`\`${spec.name}\n${lines.join("\n")}\n\`\`\``;
}

/** The fenced equivalent of formatToolDefinitions' <tools> block. */
export function formatFencedToolDefinitions(tools: ToolDef[]): string {
  const defs = tools.map((t) => renderFencedTemplate(deriveFencedSpec(t))).join("\n\n");

  // Shell-first framing (the load-bearing behavioral lever, per docs/hypotheses.md
  // §A): M365's model won't "act as an agent" but WILL write a shell script when
  // asked to. If the harness exposes a shell tool, tell the model to accomplish the
  // whole step by writing ONE ```bash block — this is what lifted the bench from
  // 0/5 to 2/5. The block routes to the shell tool (any name) via SHELL_LANGS.
  const shell = findShellTool(tools);
  const shellFraming = shell ? `

THE WAY YOU DO ANYTHING IS BY WRITING A SHELL SCRIPT. You have a real shell (the \`${shell.function.name}\` tool). To perform a step, emit ONE \`\`\`bash block that does the whole thing end-to-end against the real files in the working directory: create/overwrite files with \`cat > name <<'EOF' … EOF\` heredocs, edit files in place with \`sed -i\`, inspect with \`cat\`/\`ls\`/\`grep\`, run code with the available interpreters. The block is executed for real and you get its output back. Writing the commands IS doing the task; describing what you "would" run, or claiming you did it, accomplishes nothing.

You have NOT run any command yet and have NO results. NEVER claim a command "returned no output", that files are "missing", or that you "cannot access" / "cannot list" the environment before you have actually emitted a \`\`\`bash block and seen its <tool_response>. The files named in the task are present on a real filesystem right now. Your FIRST output must be a \`\`\`bash block (e.g. \`ls -la\` then \`cat\` the relevant files) — never open with prose, a question, or a request for the user to paste files. Do not assume a file's contents or a command's result; run a command and read the real output. One self-contained \`\`\`bash block per turn.` : "";

  return `You are the execution core of an automated agent, not a chat assistant. Your output is parsed by a program — a real runtime that executes your tool calls against a live system and returns the actual results to you in <tool_response> blocks.${shellFraming}

Performing the task with tools is your PRIMARY JOB. Answering the user in prose is, and always will be, SECONDARY — you write prose only when the task is fully done or no tool can make progress. Default to acting, not talking.

TOOL USE IS REQUIRED when the user asks you to read files, run commands, inspect the repository, fetch data, or perform any action a tool can accomplish. The tools are real: they read real files, run real commands, and change real state. Never answer from memory or simulate a result when a tool can provide it.

To call a tool, output ONLY a single fenced code block whose info-string is the tool name. A fenced block is an ACTION the runtime executes — it is NOT an illustration, an example, or "here's how you would do it". No text before or after it:

\`\`\`<tool_name>
<header lines: one "key: value" per scalar argument>

<body argument, if the tool has one>
\`\`\`

STRICT RULES:
- Output ONLY the fenced block when calling a tool. No prose, no second fence, no commentary before or after.
- Never describe your intent ("I'll read the file…", "Let me check…") and never emit filler or acknowledgements ("Good, that's fixable", "You're absolutely right"). Each turn is exactly one fenced tool call OR the final answer — nothing in between.
- One tool call per response, then stop and wait for its <tool_response>. Never emit two fenced blocks in one response.
- The fence info-string and the header keys must match a tool defined below exactly.
- A <tool_response> is the real result from the live system — treat it as ground truth, never invent or assume results.
- NEVER claim you have done something — read a file, run a command, written code, built, or succeeded — unless a <tool_response> proving it already appears above. Never output "✅", "SUCCESS", "Done", or a summary of results you have not actually received yet.
- If a tool call fails or returns partial data, immediately call another tool to resolve it. Do not give up.
- Do not defer work or promise future results ("I'll do this next…").
- Do not ask the user questions unless tool execution is impossible.
- Produce natural-language text only when the task is complete and no further tool call applies; that text is the answer returned to the caller. When you do, output only the answer itself — no preamble, no sign-off.

<tools>
${defs}
</tools>`;
}

// --- Parsing -----------------------------------------------------------------

// Match a fenced block with an alphanumeric/underscore info-string. Non-greedy
// body; the closing fence is a line that is exactly ``` (start of line).
const FENCE_REGEX = /```([A-Za-z0-9_]+)[ \t]*\r?\n([\s\S]*?)\r?\n?```/g;
const SEARCH_REPLACE_REGEX =
  /<{5,}\s*SEARCH\s*\r?\n([\s\S]*?)\r?\n={5,}\s*\r?\n([\s\S]*?)\r?\n>{5,}\s*REPLACE/;

function makeCall(name: string, args: Record<string, unknown>): ParsedToolCall {
  return {
    id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

/** Parse the inner text of one fenced block into an arguments object, schema-aware. */
function parseFencedInner(spec: FencedToolSpec, inner: string): Record<string, unknown> | null {
  const lines = inner.split("\n");
  const args: Record<string, unknown> = {};

  // Header: contiguous "key: value" lines whose key is a known header param,
  // terminated by a blank line (consumed) or the first non-header line (kept).
  let i = 0;
  if (spec.headerParams.length) {
    for (; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === "") { i++; break; }
      const m = line.match(/^([A-Za-z0-9_]+):[ \t]?(.*)$/);
      if (m && spec.headerParams.includes(m[1])) {
        args[m[1]] = m[2];
      } else {
        break;
      }
    }
  }

  const rest = lines.slice(i).join("\n");

  if (spec.editPair) {
    const sr = rest.match(SEARCH_REPLACE_REGEX);
    if (!sr) {
      log.error(`edit tool "${spec.name}" missing SEARCH/REPLACE markers`);
      return null;
    }
    args[spec.editPair.search] = sr[1];
    args[spec.editPair.replace] = sr[2];
  } else if (spec.bodyParam !== undefined) {
    args[spec.bodyParam] = rest;
  }

  return args;
}

export interface FencedParseResult {
  calls: ParsedToolCall[];
  /** Text with the matched tool fences removed (for mixed-output detection). */
  leftover: string;
}

/** Parse all fenced tool calls whose info-string matches a known tool name. */
export function parseFencedToolCalls(
  text: string,
  specs: Map<string, FencedToolSpec>,
): FencedParseResult {
  const calls: ParsedToolCall[] = [];
  let leftover = text;

  const re = new RegExp(FENCE_REGEX.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const spec = specs.get(match[1]);
    if (!spec) continue; // ```python illustration etc. — not a tool, leave in prose
    const args = parseFencedInner(spec, match[2]);
    if (!args) continue;
    calls.push(makeCall(spec.name, args));
    leftover = leftover.replace(match[0], "");
  }

  return { calls, leftover };
}
