# opencode-m365

Use Microsoft 365 Copilot as an LLM backend for [OpenCode](https://opencode.ai/) and [OpenClaw](https://docs.openclaw.ai/). Wraps M365 Copilot's WebSocket API in an OpenAI-compatible interface with tool calling support.

## How it works

M365 Copilot uses a SignalR WebSocket protocol, not the OpenAI API. This project translates between the two:

1. **OpenCode plugin** — Intercepts OpenAI-format requests via a custom `fetch` function (no proxy server needed). Handles everything in-process.
2. **Standalone proxy** — HTTP server on port 4141 with `/v1/chat/completions` and `/v1/models` endpoints. Works with any OpenAI-compatible client.
3. **OpenClaw plugin** — Config generator + setup CLI for OpenClaw's provider system.

### Tool calling

M365 Copilot doesn't support OpenAI-style `tool_calls` natively. Instead:

- Tool definitions are injected into the prompt as a compact text list
- The model outputs tool calls using fenced code blocks: `` ```tool_call\n{"name": "bash", "arguments": {"command": "ls"}}\n``` ``
- The proxy/handler parses these blocks and converts them to OpenAI `tool_calls` format
- A `reply` tool lets the model produce text responses in the same format, which gets converted back to plain text

### Agent mode

On first use, the system creates a **Copilot Studio agent** with tool-calling instructions baked into its server-side system prompt. This is done via the PowerPlatform API:

1. Discovers the environment URL via the BAP API (`api.bap.microsoft.com`)
2. Creates a bot with instructions in the Copilot Studio `minimalBots` API
3. Publishes the bot to get a `TitleId`
4. Uses the agent ID (`T_{titleId}.{botId}.gpt.default`) in WebSocket chat requests
5. Caches the agent ID in `~/.config/opencode-m365/agent-id.json`

### Conversation reuse

Each OpenCode session reuses the same M365 conversation (same `sessionId` + `conversationId`). The WebSocket reconnects per turn but M365 maintains server-side context. This saves quota — the 600 message limit applies per-conversation.

## Packages

```
@opencode-m365/core          — Shared: auth, WebSocket client, tool formatting, proxy server, agent management, session
├── @opencode-m365/proxy     — Standalone HTTP proxy binary
├── opencode-m365-auth       — OpenCode plugin (in-process, no proxy needed)
└── @opencode-m365/openclaw-plugin  — OpenClaw config generator + setup CLI + skill
```

## Setup

### Prerequisites

- Node.js 24+
- pnpm 10+
- An M365 account with Copilot access
- TOTP-based MFA (the automated login needs the base32 secret)

### 1. Install

```sh
git clone https://github.com/cramt/opencode-m365
cd opencode-m365
pnpm install
pnpm build
```

### 2. Configure credentials

Create `~/.config/opencode-m365/secrets.json`:

```json
{
  "email": "you@company.com",
  "password": "your-password",
  "mfaSecret": "YOUR_TOTP_BASE32_SECRET"
}
```

On first run, the system does an automated browser login (via Playwright/Chromium) to get OAuth tokens. After that, tokens refresh silently from the MSAL cache.

### 3. Use with OpenCode

Add to your project's `opencode.json`:

```json
{
  "plugin": ["opencode-m365-auth"],
  "provider": {
    "m365": {
      "name": "M365 Copilot",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://m365-copilot.local/v1"
      },
      "models": {
        "m365-copilot": { "name": "M365 Copilot (Auto)" },
        "quick": { "name": "GPT Quick" },
        "think-deeper": { "name": "GPT Think Deeper" },
        "gpt-5.4": { "name": "GPT-5.4 Think Deeper" },
        "gpt-5.4-quick": { "name": "GPT-5.4 Quick" },
        "gpt-5.3": { "name": "GPT-5.3 Quick" },
        "gpt-5.3-think-deeper": { "name": "GPT-5.3 Think Deeper" }
      }
    }
  },
  "model": "m365/m365-copilot"
}
```

The `baseURL` is a placeholder — the plugin overrides it with an in-process handler. No proxy server needed.

Then run:

```sh
opencode
# or
opencode run --model m365/m365-copilot "your prompt"
```

### 4. Use with OpenClaw

```sh
# Configure and start in one command
m365-openclaw-setup --start

# Or configure only, then start separately
m365-openclaw-setup
m365-proxy 4141
```

The proxy uses session reuse and delta messages — follow-up turns only send new messages, saving M365 quota. New conversations are detected automatically when the message array shrinks or the first user message changes.

### 5. Use as standalone proxy

```sh
npx m365-proxy 4141
# or
pnpm run dev
```

Then point any OpenAI-compatible client at `http://localhost:4141/v1`.

## Available models

| Model ID | M365 Tone | Description |
|---|---|---|
| `m365-copilot` / `auto` | magic | Default auto-routing |
| `quick` | Gpt_Quick | Fast responses |
| `think-deeper` | Gpt_Reasoning | Slower, more thorough |
| `gpt-5.4` | Gpt_5_4_Reasoning | GPT-5.4 reasoning |
| `gpt-5.4-quick` | Gpt_5_4_Quick | GPT-5.4 fast |
| `gpt-5.3` | Gpt_5_3_Quick | GPT-5.3 fast |
| `gpt-5.3-think-deeper` | Gpt_5_3_Reasoning | GPT-5.3 reasoning |
| `gpt-5.2` | Gpt_5_2_Quick | GPT-5.2 fast |
| `gpt-5.2-think-deeper` | Gpt_5_2_Reasoning | GPT-5.2 reasoning |

## Authentication

The auth flow uses Azure MSAL with PKCE:

1. **Silent refresh** — Uses cached tokens from `~/.config/opencode-m365/msal-cache.json`
2. **Automated login** — Playwright-driven browser login using stored credentials + TOTP
3. **Interactive login** — Opens browser for manual OAuth flow (fallback)

Three token scopes are acquired:
- `substrate.office.com/sydney/*` — For M365 Copilot chat
- `api.powerplatform.com/.default` — For Copilot Studio agent management
- `api.bap.microsoft.com/.default` — For environment discovery

## Environment variables

| Variable | Description |
|---|---|
| `M365_DEBUG` | Set to `1` to enable debug logging to `~/.config/opencode-m365/debug.log` |
| `M365_CACHE_FILE` | Override MSAL token cache location |
| `M365_SECRETS_FILE` | Override credentials file location |
| `CHROMIUM_PATH` | Path to Chromium binary for automated login |

## Config files

All stored in `~/.config/opencode-m365/`:

| File | Description |
|---|---|
| `secrets.json` | Login credentials (email, password, mfaSecret) |
| `msal-cache.json` | MSAL token cache (auto-managed) |
| `agent-id.json` | Cached Copilot Studio agent ID |
| `debug.log` | Debug log (when `M365_DEBUG=1`) |

## Development

```sh
pnpm install
pnpm build            # Build all packages
pnpm run dev          # Start standalone proxy on :4141
pnpm run test         # Launch opencode with M365 backend
pnpm run test:unit    # Run vitest unit + integration tests
```

## Known limitations

- Each WebSocket turn sends the full message history (no delta optimization yet)
- M365 Copilot's built-in system prompt can interfere with tool-calling instructions
- The `think-deeper` models take 10-30s per response
- Rate limit is ~600 messages per conversation
- Tool calling uses prompt injection (fenced code blocks), not native function calling — model compliance is ~90%
