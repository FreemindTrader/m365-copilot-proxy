// One-off measurement (Phase 6 of the always-reinject task).
// Method: serialize the exact <tools> block the proxy injects per turn
// (formatToolsBlock — the same call site the delta path uses), count UTF-8
// bytes, approximate tokens as chars/4. Run on Windows, so the block includes
// the host-platform note; on a Linux host the block ends at </tools>.
// Run: node scripts/measure-tools-overhead.mjs   (after pnpm build)
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { formatToolsBlock } = require("../packages/core/dist/index.mjs");

const fn = (name, description, props, required) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties: props, required: required ?? Object.keys(props) } },
});

const oneTool = [
  fn("bash", "Execute a bash command", { command: { type: "string", description: "The command to run" } }),
];

const twelveTools = [
  fn("bash", "Execute a bash command", { command: { type: "string", description: "The command to run" } }),
  fn("read", "Read a file from the local filesystem", { file_path: { type: "string", description: "Absolute path" }, offset: { type: "number" }, limit: { type: "number" } }, ["file_path"]),
  fn("write", "Write a file to the local filesystem", { file_path: { type: "string", description: "Absolute path" }, content: { type: "string", description: "File contents" } }, ["file_path", "content"]),
  fn("edit", "Replace a string in a file", { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, ["file_path", "old_string", "new_string"]),
  fn("grep", "Search file contents with a regex", { pattern: { type: "string" }, path: { type: "string" } }, ["pattern"]),
  fn("glob", "Find files by glob pattern", { pattern: { type: "string" }, path: { type: "string" } }, ["pattern"]),
  fn("ls", "List directory contents", { path: { type: "string" } }, ["path"]),
  fn("todo_write", "Write a structured task list", { todos: { type: "array", items: { type: "object" } } }),
  fn("web_fetch", "Fetch content from a URL", { url: { type: "string" }, prompt: { type: "string" } }, ["url", "prompt"]),
  fn("web_search", "Search the web", { query: { type: "string" } }, ["query"]),
  fn("notebook_edit", "Edit a Jupyter notebook cell", { notebook_path: { type: "string" }, new_source: { type: "string" } }, ["notebook_path", "new_source"]),
  fn("task", "Launch a subagent", { prompt: { type: "string" }, subagent_type: { type: "string" } }, ["prompt"]),
];

function report(label, block, turns = 100) {
  const bytes = Buffer.byteLength(block, "utf8");
  const tokens = Math.round(bytes / 4);
  console.log(`${label}`);
  console.log(`  block bytes (chars):        ${bytes}`);
  console.log(`  approx tokens (chars/4):    ${tokens}`);
  console.log(`  per-turn overhead (t>=2):   ${bytes} chars ~ ${tokens} tokens`);
  console.log(`  per-${turns}-turn overhead:   ${(turns - 1) * bytes} chars ~ ${Math.round(((turns - 1) * bytes) / 4)} tokens (${turns - 1} reinjections; turn 1 carried the block inside the framing before AND after the fix)`);
  console.log(`  per-${turns}-turn incl. turn 1: ${turns * bytes} chars ~ ${Math.round((turns * bytes) / 4)} tokens (upper bound)`);
}

report("ONE TOOL (bash)", formatToolsBlock(oneTool));
console.log("");
report("TWELVE-TOOL AGENT SET", formatToolsBlock(twelveTools));
