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
- "Performing the task with tools is your **PRIMARY JOB**. Answering the user in prose is, and always will be, SECONDARY."
- "Output ONLY a single JSON tool call. No other text." — and **no JSON keys other than `tool`/`arguments`** (M365 invents `{"confidence":N}` and `{"final":…}`).
- "Never describe your intent" and **never emit filler/acknowledgements** ("You're absolutely right", "Good, that's fixable").
- "**Never claim success** (`✅`/`SUCCESS`/`Done`) unless a `<tool_response>` proving it already appears above" — M365 loves to declare victory before the build runs.
- "When you do give the final answer, **no preamble/sign-off**" ("All right…", "let's close the loop").

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

### 3. Fail-Closed Parsing & Output Hardening (packages/proxy-lib/src/handler.ts, tools.ts)

The model's output is scrubbed regardless of whether it obeyed the prompt — this is the durable lever, since M365's chat-RLHF leaks through no matter how the prompt is tuned:

- **Mixed output:** when `parseToolCalls()` finds tool calls AND extra text, the text is **stripped**; the client gets only `tool_calls` with `content: null` (the stripped text is logged).
- **Invented JSON:** `parseToolCalls()` removes `{"confidence":N}` everywhere, **drops** a `{"final":…}` riding alongside tool calls (a premature success claim), and **unwraps** a lone `{"final":"…"}` into plain text.
- **One call per turn:** the handler keeps only the **first** tool call and discards the rest. M365 (esp. reasoning tones) batches its whole plan into one response, which runs later steps on guessed state and lets a `✅ SUCCESS` ride along at the end; forcing one call makes each step react to the real previous `<tool_response>`. Override with `M365_ALLOW_MULTI_TOOL`.
- **Empty ≠ rate limit:** an empty upstream reply is only treated as throttling when the throttle is **at-limit**; otherwise (content filter, invalid/deleted agent, transient) it fails fast after a couple of quick retries instead of a 60s escalating loop that reads as a silent hang.

## Few-Shot Examples

`fewShotExample()` builds the first-turn examples **from the client's real tools** (never a hard-coded `read_file` that may not exist — reasoning models derailed into critiquing that mismatch). It demonstrates the sustained one-call-per-turn loop with concrete values:

1. Act with a real tool (e.g. `bash`) → wait for the real `<tool_response>`
2. Act again using that result (e.g. `read`) → wait for the result
3. Give a terse, **preamble-free** final answer

Deliberately **no** chit-chat example (it taught prose answers) and **no** batching (it taught plan-dumps). This overrides M365 Copilot's default behavior of describing actions instead of taking them.
