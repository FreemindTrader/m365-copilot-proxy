# Always-Reinject Tool Definitions — Implementation Report

**Branch:** `always-reinject-tools` → `FreemindTrader/m365-copilot-proxy`
**Date:** 2026-11-16
**Objective:** OpenAI-style tool semantics — if `tools` exists in the request and
`tool_choice != "none"`, the `<tools>` block MUST appear in every outbound M365
prompt. Every turn. No exceptions.

---

## 1. Root cause summary

The proxy is stateful-relay architecture: turn 1 sends the full prompt via
`formatMessages()` (which embeds the `<tools>` block inside its framing), and
every follow-up turn sends only the new messages via `formatDeltaMessages()`.
The delta path serialized tool *results* (`<tool_response>`) but never
re-serialized the tool *definitions*. M365's server-side conversation therefore
contained the `<tools>` block exactly once — in the turn-1 framing — and nothing
in turns 2+ restated it. Tool availability depended on M365 remembering the
definitions from a previous turn; after enough turns the model reports
"The current message does not contain a definition block" and tool calling
degrades.

## 2. Call flow (before → after)

```text
BEFORE                                  AFTER
─────────────────────────────────────   ─────────────────────────────────────
OpenAI Request { tools: [...] }         OpenAI Request { tools: [...] }
  ↓                                       ↓
tool_choice != "none"?                  tool_choice != "none"?
  ↓                                       ↓
Tool Serialization (formatTool-         Tool Serialization (formatTool-
Definitions via framing variants)       Definitions + formatToolsBlock)
  ↓                                       ↓
M365 Prompt                             M365 Prompt
  turn 1: framing + <tools> ✓            turn 1: framing + <tools> ✓
  turn 2+: delta only, NO <tools> ✗      turn 2+: <tools> + delta ✓ (always)
  ↓                                       ↓
Tool Parsing (parseToolCalls)           Tool Parsing (parseToolCalls)
  depends on M365 memory → degrades      definitions present → stable
```

Outbound-prompt sites covered by the fix:

| Site | File | Reinjects? |
|---|---|---|
| Turn 1 full prompt | handler.ts (mode=full) | Already carried the block (framing) — unchanged |
| Delta turn (tool results / new user msg) | handler.ts (mode=delta) | **YES — new** |
| "Please continue." nudge (empty delta) | handler.ts (mode=retry) | **YES — new** |
| Confabulation / hallucination / remote-artifact forcing retry | handler.ts (produce) | **YES — new** |
| Empty-response quick retry ("Please continue.") | handler.ts (runBuffered) | **YES — new** |
| Disengage / agent-dead / InternalError / priority fallback (full re-send) | handler.ts | Already use `formatMessages` — unchanged |

## 3. File locations

| File | Change |
|---|---|
| `packages/core/src/fenced.ts` | Exported `formatToolsBlock(tools)` — the shared `<tools>` block (`toolsBlock()` + `hostPlatformNote()`), the identical serializer every framing variant embeds on turn 1. Not a second serialization path — same helpers, same output. |
| `packages/core/src/tools.ts` | `maybeInjectReplyTool` exported (was module-private) so the delta path applies the same effective toolset as turn 1 (incl. `M365_INJECT_REPLY_TOOL=1`). |
| `packages/core/src/index.ts` | Re-export `formatToolsBlock`, `maybeInjectReplyTool`. |
| `packages/proxy-lib/src/handler.ts` | Delta path prepends the block on every tool-enabled follow-up prompt; `ConversationState.fingerprint` + `.lastToolHash` (diagnostics only); `[TOOLS]` log line; sha256 toolset-change event. |
| `packages/proxy-lib/src/tools-reinject.test.ts` | **New** — T1–T7 + serializer-parity test. |
| `packages/proxy-lib/src/streaming.test.ts` | 1 assertion updated: the only-first-call-ran note is no longer the *first* text of a delta turn (the `<tools>` block now precedes it). |
| `scripts/measure-tools-overhead.mjs` | **New** — re-runnable overhead measurement. |

Not modified: routing, session affinity, auth, `SessionPool.fingerprint`,
tool-call parsing, framing variants' turn-1 output (byte-for-byte unchanged).

## 4. Diff summary

`git diff main...always-reinject-tools --stat`:

```text
 packages/core/src/fenced.ts               |  21 +++++++++
 packages/core/src/index.ts                |   4 +++
 packages/core/src/tools.ts                |   2 +-
 packages/proxy-lib/src/handler.ts         |  65 +++++++++++++++++++++++-
 packages/proxy-lib/src/streaming.test.ts  |   7 +++-
 packages/proxy-lib/src/tools-reinject.test.ts | 278 +++++++++++++++++++++++++++++
 scripts/measure-tools-overhead.mjs        |  60 +++++++++++++++
 7 files changed, ~435 insertions(+), ~15 lines touched
```

Key handler change (delta path):

```ts
// toolReinjectPrefix = hasTools ? toolsBlockText + "\n\n" : ""
text = `${toolReinjectPrefix}${delta}`;          // mode=delta
text = `${toolReinjectPrefix}Please continue.`;  // mode=retry
text = `${toolReinjectPrefix}${conv.pendingNote}\n\n${delta}`;  // note turns
text = `${toolReinjectPrefix}${forcePrompt}`;    // forcing retries
```

Injection rule (single decision point, `toolReinjectPrefix`):

- request WITH `tools` and `tool_choice != "none"` → prefix non-empty → always inject
- request WITHOUT tools → prefix empty → never inject
- `tool_choice = "none"` → `hasTools` false → never inject

## 5. Test results (T1–T8)

`packages/proxy-lib/src/tools-reinject.test.ts` — 8 tests, all green:

| # | Test | Result |
|---|---|---|
| T1 | Turn 1 contains `<tools>` (and names the tool) | PASS |
| T2 | Turn 2 contains `<tools>` AND `<tool_response>`; block precedes delta | PASS |
| T3 | 100-turn loop — all 100 outbound prompts contain `<tools>`; every tool turn has `<tool_response>` | PASS |
| T4 | No tools → no `<tools>` in any prompt | PASS |
| T5 | `tool_choice="none"` → no `<tools>` in any prompt | PASS |
| T6 | Turn 1 prompt byte-for-byte unchanged (`toBe(formatMessages(...))`) | PASS |
| T7 | Toolset change → fresh M365 conversation + new definitions in prompt | PASS |
| T8 | Existing suite remains green | PASS (see below) |
| + | Reinjected block is a substring of the turn-1 framing output (same serializer) | PASS |

**T8 / full suite** (`pnpm install && pnpm test`):

```text
 Test Files  2 failed | 17 passed | 1 skipped (20)
 Tests       2 failed | 421 passed | 6 skipped (429)
```

The 2 failures are **pre-existing on `main`** (verified by `git stash` +
re-run before committing): `packages/core/src/log.test.ts` ("take an absolute
path as is") and `scripts/bench/turn-budget.test.mjs` ("reads the proxy's
M365_LOG_FILE"). Both are Windows log-path environment tests, untouched by
this change and failing identically without it.

One test in `streaming.test.ts` required updating for the new behavior: the
only-first-call-ran note previously started the delta turn's text; the note is
still prepended ahead of the delta but now sits after the reinjected
`<tools>` block, so the assertion was updated from `startsWith(NOTE)` to
ordered `toContain` (tools < note < tool_response).

## 6. Tool injection evidence

Diagnostic line added per Phase 4 (`M365_DEBUG=1`), captured live from the
T1–T3 test run:

```text
[INFO] [handler] [TOOLS] conv=1346079830 turn=0 tools=1 injected=YES bytes=975 hash=93c53b56d5bef886
[INFO] [handler] [TOOLS] conv=1346079830 turn=1 tools=1 injected=YES bytes=975 hash=93c53b56d5bef886
[INFO] [handler] [TOOLS] conv=1346079830 turn=2 tools=1 injected=YES bytes=975 hash=93c53b56d5bef886
... (T3 loop continues through turn=99, injected=YES on every line)
```

Implementation details:

- `ConversationState.lastToolHash` = sha256(serialized block), first 16 hex chars.
- A toolset change with unchanged tool *names* (same fingerprint, different
  definitions) logs: `[TOOLS] conv=<fp> toolset changed: <old> -> <new> — re-serializing definitions`.
- `ConversationState.fingerprint` surfaces the session-pool key in the log line.
- Both fields are diagnostics-only: never read for routing, session affinity,
  or auth decisions.

## 7. Token overhead measurements

Method: `node scripts/measure-tools-overhead.mjs` — serializes the exact block
the proxy injects (`formatToolsBlock`, the same call site as the delta path),
counts UTF-8 bytes, approximates tokens as chars/4. Measured on a Windows host,
so the block includes the per-turn host-platform note (~660 chars,
Windows-only); on a Linux host the block ends at `</tools>`. Turn 1 is excluded
from *marginal* overhead — its block rode inside the framing before AND after
the fix.

| Toolset | Block chars | ≈ tokens | Per-turn overhead (turn 2+) | Per-100-turn overhead (99 reinjections) |
|---|---|---|---|---|
| 1 tool (`bash`), Windows host | 981 | ~245 | 981 chars (~245 tok) | 97,119 chars (~24,280 tok) |
| 1 tool (`bash`), Linux host | 70 | ~18 | 70 chars (~18 tok) | 6,930 chars (~1,730 tok) |
| 12-tool agent set, Windows host | 1,947 | ~487 | 1,947 chars (~487 tok) | 192,753 chars (~48,190 tok) |
| 12-tool agent set, Linux host | 961 | ~240 | 961 chars (~240 tok) | 95,139 chars (~23,800 tok) |

Interpretation: M365 accepts ≥500k tokens of input (docs/hypotheses.md F9),
and a typical agentic session is tens of turns, not hundreds. At ~245–487
tokens per turn the reinjection is well within headroom, and it is strictly
cheaper than the alternative failure mode: a degraded mid-session tool-call
loop that must be restarted (a fresh conversation re-sends the FULL history).

## 8. Before / after comparison

| | Before | After |
|---|---|---|
| Turn 1 prompt | framing + `<tools>` | **unchanged (byte-identical, T6)** |
| Turn 2+ prompt | delta only, no definitions | `<tools>` + delta |
| Forcing retries | force prompt only | `<tools>` + force prompt |
| "Please continue." nudge | no definitions | `<tools>` + nudge |
| Model without tools / tool_choice=none | no definitions | no definitions (unchanged) |
| Tool availability turn 2+ | dependent on M365 memory; degrades after N turns | restated every turn (OpenAI semantics) |
| Diagnostics | none | `[TOOLS]` line per turn + sha256 toolset-change event |
| Routing / affinity / auth | — | untouched |

## 9. Merge recommendation

**Recommend merging.** The fix is additive and narrow: one exported serializer
(composed entirely of existing helpers — no second serialization path), one
prefix applied at the delta-turn prompt-assembly points, diagnostics-only state,
and tests. Turn-1 behavior is proven byte-identical (T6); the no-tools and
`tool_choice=none` paths are proven injection-free (T4, T5); a 100-turn loop
proves the contract holds (T3). The full suite is green except two
pre-existing Windows log-path failures on `main` itself. Overhead
(~245 tokens/turn for a lean toolset on Windows; ~18/turn on Linux) is
negligible against the observed ≥500k-token input tolerance and strictly
cheaper than restarting degraded sessions.

Suggested follow-ups (non-blocking): fold the two pre-existing log-path test
failures into a Windows-tolerant fixture; consider making the host-platform
note part of the measured block on the deployment host before capacity
planning.

## 10. Addendum — branch rename and long-session validation (2026-11-16)

**Branch:** the work now lives on `feature/persistent-tool-schema`
(same commit lineage as `always-reinject-tools`; unified diff archived at
`docs/persistent-tool-schema.diff`).

**T9 long-session synthetic workload** (`packages/proxy-lib/src/tools-reinject.test.ts`):
single conversation, **160 turns, 160 tool calls**, per-turn record
`{ turn, tools_present, tool_call_generated, tool_call_executed }`. Run with
`M365_LONG_SESSION_OUT=<path>` to dump the records as JSON.

Result (records archived, 160/160):

| Check | Result |
|---|---|
| turns | 160 |
| tool calls executed (`finish_reason=tool_calls`) | 160/160 |
| `tools_present` (block in every outbound prompt) | 160/160 — **0 failures** |
| "missing `<tools>`" / "does not contain a definition block" | never observed |
| conversations created | 1 (single conversation) |
| `tools_block_bytes` | constant 975/turn (stable serialization, stable hash) |

**Benchmark re-run** (`node scripts/measure-tools-overhead.mjs`, Windows host,
numbers reproduce §7 exactly): 1-tool block 981 chars ≈ 245 tok/turn;
12-tool block 1,947 chars ≈ 487 tok/turn.

**Logging gate confirmed:** the `[TOOLS]` diagnostics line flows through core's
`log.ts`, which writes only when `M365_DEBUG` or `M365_TRACE` is set — default
OFF, as required.
