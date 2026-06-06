# AGENTS.md

Guidance for AI agents (and humans) working in this repo.

## What this is

`m365-copilot-proxy` wraps Microsoft 365 Copilot's undocumented SignalR/WebSocket
API in an **OpenAI-compatible** interface so OpenAI-compatible coding agents (notably
[pi](https://pi.dev/)) can use it as a model backend.

**Read [`docs/m365-copilot-api.md`](docs/m365-copilot-api.md) before touching the
protocol code** — it documents every quirk of the M365 API (auth, SignalR frames,
tones, throttling, the "Disengaged" filter, Copilot Studio agents). It is the source
of truth; keep it in sync if you change protocol behaviour.

## Layout (pnpm workspace, all TypeScript/ESM)

| Package | Role |
|---|---|
| `@m365-copilot/core` | auth (MSAL+Playwright), WebSocket client, sessions, agent mgmt, tool formatting, schemas |
| `@m365-copilot/proxy-lib` | OpenAI↔M365 translation: Hono app, `SessionPool`, handler, tool-call parsing |
| `@m365-copilot/proxy` | standalone HTTP proxy binary (`m365-proxy`) |
| `@m365-copilot/openclaw-plugin` | OpenClaw config generator + setup CLI |

`scripts/` holds dev/diagnostic tools (`login-probe`, `proxy-verify`, `toolformat-experiment`).

## Build & test

```sh
pnpm install
pnpm build          # tsdown, all packages (tests import from dist/, so build first)
pnpm test           # = test:unit; pure unit tests, NO auth/network
pnpm test:live      # M365_LIVE=1; live tests that hit real M365 (uses quota)
```

- ESM with `.js`-suffixed relative imports (tsdown/Node ESM). Keep that convention.
- Zod for boundary validation. No `console.log` in library code — use `createLogger`.
- `vitest run` skips live tests unless `M365_LIVE=1` (see `describe.skipIf`).

## Running against real M365 (important)

- **Run inside the Nix dev shell**: `nix develop --command bash -c '...'`. It provides
  `CHROMIUM_PATH` (a system Chromium); Playwright's bundled one is broken on NixOS.
- Auth uses `~/.config/opencode-m365/secrets.json` (email/password/mfaSecret) +
  `msal-cache.json`. **This data dir keeps the legacy `opencode-m365` name** — do not
  rename it or you orphan working credentials.
- Set `M365_DEBUG=1` to log to `~/.config/opencode-m365/debug.log`. Set
  `M365_NO_INTERACTIVE=1` in automated runs so a login fallback can never open browser tabs.
- **Mind the quota**: ~600 messages **per conversation**, plus account-level throttling.
  Don't burn it on loops. A "rate limited / empty response" is often actually a
  `Disengaged` refusal (see the API doc), not throttling.

## Gotchas to know before you "fix" something

- **Tool calling only works via a Copilot Studio agent.** The per-request JSON format
  (bare vs ```` ```json ````) barely matters; the agent's server-side prompt is the lever.
- **`agent.ts::updateBotInstructions` is dead code** — `getOrCreateAgent` only republishes
  an existing agent. Editing `getAgentInstructions()` has NO effect on an already-created
  agent; you must delete+recreate the bot.
- **M365 disengages on large tool payloads.** Keep injected toolsets lean. This is why
  pi works and heavy harnesses (opencode) don't.
- The `nativeclient` OAuth redirect bounces to `/common/wrongplace`; the auth code is
  scraped from the navigation request, not a settled URL.

## Verifying changes end-to-end

```sh
# proxy smoke + tool call + multiturn (run unsandboxed, inside nix develop):
nix develop --command bash -c 'M365_DEBUG=1 node scripts/proxy-verify.mjs --agent --multiturn'
```

## Conventions

- Conventional Commits (`fix:`, `feat:`, `docs:`, `chore:`, `build:`). No `Co-Authored-By` lines.
- Small, focused files; handle errors explicitly; prefer immutable updates.
