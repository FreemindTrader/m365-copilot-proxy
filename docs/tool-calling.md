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

### 2. Plugin System Prompt (packages/opencode-plugin/src/index.ts)

The OpenCode plugin replaces the default system prompt with a minimal one that mirrors the same rules, ensuring they apply even when the proxy-level prompt is the only layer of defense.

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
