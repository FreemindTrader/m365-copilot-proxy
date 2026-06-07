# Tool Calling Contract

This proxy translates OpenAI-compatible tool calls to/from M365 Copilot. Because M365 doesn't natively support the OpenAI tool-calling protocol, we prompt-engineer it via a system prompt and enforce the contract at the proxy layer.

## Output Contract

When tools are available and the model decides to use one:

**The model MUST output ONLY a JSON tool call. No other text.**

### Correct

```
{"tool": "read_file", "arguments": {"path": "/etc/hostname"}}
```

### Incorrect

```
I'll read that file for you now.
{"tool": "read_file", "arguments": {"path": "/etc/hostname"}}
```

```
{"tool": "read_file", "arguments": {"path": "/etc/hostname"}}
Let me know if you need anything else.
```

```
Let me check the file contents:
{"tool": "read_file", "arguments": {"path": "/etc/hostname"}}
The file should contain the hostname.
```

## Enforcement

The contract is enforced at three layers:

### 1. System Prompt (packages/core/src/tools.ts)

`formatToolDefinitions()` injects strict rules into every tool-enabled request:
- "TOOL USE IS REQUIRED when..."
- "Output ONLY a single JSON tool call. No other text."
- "Never describe your intent."

### 2. Copilot Studio Agent System Prompt (packages/core/src/agent.ts)

The most important layer: an auto-created Copilot Studio agent carries tool-calling
instructions in its **server-side** system prompt. Without the agent, M365 ignores the
per-request injection and answers in prose (or hallucinates). See
[m365-copilot-api.md](./m365-copilot-api.md) for why.

These instructions are baked in at agent-creation time and can't be cheaply updated in
place, so the agent is **versioned by name**: it's called `m365-tool-agent-<hash>`, where
`<hash>` is a short SHA-256 of the current instructions. Editing `getAgentInstructions()`
changes the hash, so the next request provisions a fresh agent and a cleanup pass retires
the stale ones. Hosts sharing a tenant compute the same name for the same instructions and
converge on one agent with no coordination. Set `M365_AGENT_NO_CLEANUP` to keep old
versions around (e.g. while several hosts on different versions share a tenant).

### 3. Fail-Closed Parsing (packages/proxy-lib/src/handler.ts)

When `parseToolCalls()` detects both tool calls AND extra text content:
- The text is **stripped** before returning the response to the client.
- The client receives only `tool_calls` with `content: null`.
- The stripped text is logged for debugging.

This means even if the model drifts and starts adding explanations alongside tool calls, downstream clients always receive clean tool-call-only responses.

## Few-Shot Examples

The first turn includes few-shot examples in `formatMessages()` that demonstrate the correct pattern to M365 Copilot:

1. User asks to read a file -> Assistant outputs only the tool call JSON
2. Tool response is returned -> Assistant summarizes the result
3. User asks a non-tool question -> Assistant responds with plain text

These examples override M365 Copilot's default behavior of describing actions instead of taking them.
