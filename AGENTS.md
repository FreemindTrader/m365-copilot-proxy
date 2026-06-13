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

[`docs/hypotheses.md`](docs/hypotheses.md) is the open-questions notebook —
tool-call compliance experiments, the search for token/context-window data, the
"how do we improve this proxy" backlog. Update it whenever an experiment lands.

## How we work — hypothesis-driven (default)

This is a reverse-engineering project against an undocumented API. **The default
mode is science: turn every "I think X" into a testable hypothesis, design the
cheapest probe that would confirm or kill it, run it, and record the result.**
Don't guess what works — measure it. Don't stop at a plausible inference when the
live API or the benchmark can settle it. Always be looking for the next testable
hypothesis that teaches us something.

- **Log every hypothesis in [`docs/hypotheses.md`](docs/hypotheses.md)** with a
  falsification criterion and a probe idea; update it when an experiment lands
  (confirmed / disproved, with sample size + evidence pointer).
- **[`docs/experiments.md`](docs/experiments.md) is the runnable catalog** — each
  experiment is a hypothesis + exact commands + how to read the result. Reach for
  it to *run* something; add to it when you design a new experiment.
- **Probes live in `scripts/`** — small, single-purpose, read-mostly. Reuse
  `scripts/_probe-chat.mjs` (one M365 turn in → structured result out; supports
  `optionsSets` / `extraAllowed` / `plugins` / `variants` / `tone` / agent
  overrides) and copy an existing probe rather than starting from scratch.
- **Quantify with the benchmark** — `scripts/bench/` (Terminal-Bench-style) scores
  real agentic coding tasks objectively, executing every tool call in a
  `--network none` Docker sandbox. To compare *any* lever (tool format, model/tone,
  prompt, optionsSets) run it with a `--label` and diff the scorecards in
  `scripts/bench/out/`. "Best" is a pass-rate number, not an opinion. See
  `scripts/bench/README.md`.
- Prefer empirical evidence — what the real first-party client sends/receives
  (capture it with Playwright), what the bench scores — over schema guesses.

## Layout (pnpm workspace, all TypeScript/ESM)

| Package | Role |
|---|---|
| `@m365-copilot/core` | auth (MSAL+Playwright), WebSocket client, sessions, agent mgmt, tool formatting, schemas |
| `@m365-copilot/proxy-lib` | OpenAI↔M365 translation: framework-free `createApp()` fetch handler, `SessionPool`, handler, tool-call parsing |
| `@m365-copilot/proxy` | standalone **Nitro** service / proxy binary (`m365-proxy`); file-based `routes/`, startup-auth `plugins/`, builds to `.output/` |
| `@m365-copilot/openclaw-plugin` | OpenClaw config generator + setup CLI |

`scripts/` holds RE probes + dev tools (`_probe-chat` helper, `proxy-verify`,
frame/optionsSets/tone probes, `gateway-*` captures) and **`scripts/bench/`** — the
quantitative benchmark. See the hypothesis-driven section above.

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
- **The agent is versioned by an instructions hash.** Its name is
  `m365-tool-agent-<sha256(instructions)[:8]>`, so editing `getAgentInstructions()` auto-
  provisions a fresh agent on the next request and a cleanup pass retires the old one
  (`M365_AGENT_NO_CLEANUP` to skip). `updateBotInstructions()` is still dead code — we
  re-create rather than update in place. Multi-host footgun: a host on new code deletes the
  old agent that hosts on old code may still be using mid-conversation. See API doc §10.
- **Reasoning tones don't work with the agent.** `gpt-5.x` / `*-think-deeper` route through
  the `DeepLeo` reasoning pipeline, which meta-analyzes the injected prompt instead of
  obeying it. Only the default `magic` and `*-quick` tones behave. The model can't be bound
  to our (declarative `minimalBots`) agent type at all — see API doc §10 *Agent types*.
- **M365 disengages on large tool payloads.** Keep injected toolsets lean. This is why
  pi works and heavy harnesses (opencode) don't. The proxy also enforces one tool call per
  turn and strips M365's invented `{confidence}`/`{final}` JSON (`M365_ALLOW_MULTI_TOOL` to opt out).
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
