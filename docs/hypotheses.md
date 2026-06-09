# Reverse-engineering hypotheses & experiments

A live notebook of things we've **guessed**, things we've **tested**, and the
levers each one gives us. Update as we learn. The companion API doc
([`m365-copilot-api.md`](m365-copilot-api.md)) is for confirmed protocol
behaviour; this is the messy "we haven't shipped it yet" layer.

Status legend: 🟢 confirmed · 🟡 partially tested · 🔴 untested guess ·
⚫ disproved.

Findings should carry **n** (sample size), **service version under test**,
and **falsification criteria** wherever they're claiming something stronger
than "we eyeballed one run." See §M (Methods) for the experimental rig.

**Contents**

- §M — Methods (rig, raw-data pointers, caveats, falsification criteria)
- §0 — Headline findings (F1…F8) with confidence ratings
- §1 — Tool-call compliance hypotheses (most resolved June 9)
- §2 — Token-usage search (mostly disproved or low-confidence)
- §3 — "Context-window %" — what M365 actually enforces
- §4 — Frame surface area we haven't fully mined
- §5 — Disengaged-filter open questions
- §6 — Cost / metering open questions
- §7 — Probe backlog, ordered by info-gain ÷ cost

---

## M. Methods — how the June 9 2026 data was collected

### Environment
- **Tenant:** single, dev account `ao@re-zip.com` (tid `fa7f56d8-49c4-4327-b816-9a0eeaa273df`).
- **Region:** Sydney back-end `substrate.office.com`; observed `locationInfo.country: DK`.
- **M365 service version under test:** `1.0.03443.34112` (from `result.serviceVersion` in `type:2` stream items). Quote this when reproducing — Microsoft changes behaviour without notice.
- **Tone:** `magic` (auto-routing) for all experiments unless noted.
- **Agent:** Copilot Studio agent `m365-tool-agent-e1c3f258` (instructions hash from this commit). Same agent across all runs unless noted.
- **Client:** the proxy at this repo's HEAD (with the changes documented in commits `75129b3`, `2350a2e`, `0538492`).
- **Time window:** 2026-06-09 06:53 — 07:17 UTC. Single ~25-minute window — diurnal/load effects not controlled for.

### Probes used
| Script | Cost per run | What it measures |
|---|---|---|
| `scripts/frame-dump-probe.mjs` | 1 chat msg | Every key of every WS frame from one turn; flags token/usage-shaped values. |
| `scripts/frame-dump-disengage.mjs` | 1 chat msg | Same but with a deliberately-Disengage-shaped prompt (12 tools + jailbreak framing). |
| `scripts/tool-compliance-experiment.mjs` | `variants × prompts × --repeat` msgs | A/B of prompt variants. With `--repeat N`, reports median/p95 latency + dea_violation. |
| `scripts/usage-endpoint-hunt.mjs` | 0 (GETs only) | Sweeps candidate REST URLs across Sydney/PP/BAP. |

### Raw captures
All gitignored under `scripts/*-out/<timestamp>/`. Per-experiment pointers in §0.
A run can be re-played offline by walking `raw-frames.ndjson`.

To capture frames from the **running proxy** (not just from probes), set
`M365_DUMP_FRAMES=1`. Frames land in
`~/.config/opencode-m365/frames/<requestId>.ndjson`, one file per turn,
both `send` and `recv` directions. Useful for diagnosing a regression in
production without re-running the bisect.

### Caveats and threats to validity
1. **n=1 per cell** on most claims. The tool-compliance scoreboard ran once
   through 30 cells. Compliance counts (`5/5`, `3/5`) are descriptive of
   that single run; latency means without `--repeat` are noise. Re-run with
   `--repeat 3` (or more) before treating any number ±10% as load-bearing.
2. **Single tenant, single tone, single agent version.** Findings about
   compliance or scores may be artefacts of this account's licence
   (`Starter`), region, or the specific server-side prompt our agent has
   baked in. Cross-tenant reproduction is unverified.
3. **Single short time window.** All runs landed inside ~25 minutes. We
   haven't ruled out diurnal load effects on latency or Disengaged.
4. **Order effects.** Each variant runs all its prompts before the next
   variant. Account-level throttling (if any) would penalise late variants.
   `tool_choice_req` was last in our run — its high latency could be partly
   throttling, not the variant.
5. **`magic` tone only.** The reasoning tones (`*_Reasoning`, `DeepLeo`
   pipeline) historically misbehave with agents. None of our compliance
   findings transfer to them without re-testing.
6. **Disengaged didn't fire.** Our 12-tool jailbreak-framed probe didn't
   trip the filter. Either the filter eased, our agent protects us, or
   we'd need genuinely abusive content. The "9–10 orders of magnitude
   safer" claim is calibrated only against the prompts we ran; the
   threshold above which Disengaged fires is unknown.
7. **Scoreboard verdict is a heuristic.** `OK_TOOL+stray(N)` counts as
   compliant because the proxy strips the stray text downstream — but the
   model is misbehaving. Don't read 5/5 as "perfectly compliant"; read it
   as "useful output recoverable by the handler."
8. **No cost model.** All experiments burned the same 600-msg-per-conv
   quota. We ran ~40 chat turns in the dig — that's ~7% of one conv's
   budget. Real bisects (`variants-bisect.mjs`) eat ~10 each.

### Falsification criteria

Use these as triggers to revisit:

| Finding | Re-test if … |
|---|---|
| Few-shot is dead weight | A new tone/model is added and gets <100% compliance without the few-shot. |
| `tool_choice:"required"` is harmful | Our prompt-rule translation changes (currently a flat sentence). |
| `reply()` injection works | Mixed-tool-call output increases or `OK_REPLY` rate drops on prose. |
| Scores reflect Disengaged proximity | We observe a `Disengaged` response with `dea_violation < 1e-3` (i.e., low score didn't predict safety). |
| Sydney REST endpoints don't exist | A new probe with full browser headers gets non-empty 200/4xx (not empty 500). |
| 600-msg-per-conv is the cap | We observe `maxNumUserMessagesInConversation != 600` on any conversation. |

---

## 0. Headline findings from the June 9 2026 dig

For each finding: claim · evidence (n + raw data) · confidence · caveats.

---

### F1 — M365 emits its own classifier scores on every bot message 🟢

**Claim.** Every bot message in the `update` and `type:2` frames carries
`scores: [{component, score}]` with at least two components: `BotOffense`
(generic) and `dea_violation` (disengagement-eligibility). The `dea_violation`
component correlates with the prompt's "jailbreak-ness" by 9–10 orders of
magnitude.

**Evidence.** 3 single-prompt captures:

| Prompt shape | BotOffense | dea_violation | n | raw |
|---|---|---|---|---|
| Clean prose ("pong") | 1.3 × 10⁻⁷ | 2.8 × 10⁻⁶ | 1 | `frame-dump-out/2026-06-09T06-53-50-370Z/raw-frames.ndjson` |
| Clean lean tool call (3 tools, soft prompt) | 2.2 × 10⁻¹³ | 2.1 × 10⁻⁸ | 1 | `frame-dump-out/2026-06-09T06-57-43-254Z/raw-frames.ndjson` |
| 12-tool + ALL-CAPS jailbreak framing | 1.2 × 10⁻³ | 2.2 × 10⁻³ | 1 | `frame-dump-out/2026-06-09T06-59-42-093Z-disengage/raw-frames.ndjson` |

Repeat-sample from the compliance experiment (n=5, same baseline variant)
shows `dea_violation` between 2.5e-7 and ~5e-7 — stable to within ~2×, so
the order-of-magnitude separation between prompt shapes is robust under
sampling noise.

**Confidence.** High that scores exist and roughly track prompt risk.
Low that the absolute thresholds we measured generalise (single tenant,
single tone).

**Falsification.** Score absent from any new frame capture, OR a Disengaged
response observed with `dea_violation < 1e-3`.

**Now exposed.** `usage.x_m365_dea_score`, `usage.x_m365_offense_score`,
`usage.x_m365_classifier_scores` (whole map). Code:
`packages/proxy-lib/src/handler.ts::buildUsage`.

---

### F2 — The few-shot in our tool prompt is dead weight 🟢

**Claim.** Removing the few-shot example block from the per-request prompt
does not measurably hurt tool-call compliance and saves latency.

**Evidence.** `tool-compliance-experiment.mjs` June 9 run, **n=1 per cell**,
5 prompts × 6 variants = 30 cells total.

| Variant | Compliance | Mean latency¹ |
|---|---|---|
| baseline (with few-shot) | 5/5 | 5388 ms |
| **no_fewshot** | 5/5 | **4893 ms** |

¹ Mean across 5 single-shot runs. **Single-sample latency — error bars unknown.**

**Confidence.** Medium on the "doesn't hurt compliance" claim (n=5 is enough
to spot a big regression; not enough for marginal ones). Low on the
"~10% faster" claim — could be order-of-trial effect (no_fewshot ran third,
when no throttling had built up).

**Falsification.** Re-run with `--repeat 5` and randomised variant ordering.
If `no_fewshot` is statistically slower or scores <100%, restore the
few-shot.

**Now applied.** Few-shot off by default; restore with `M365_KEEP_FEWSHOT=1`.
Code: `packages/core/src/tools.ts::formatMessages`.

**Raw data.** `tool-compliance-out/2026-06-09T07-04-46-817Z/results.json`.

---

### F3 — `tool_choice: "required"` is actively harmful 🟢

**Claim.** Translating `tool_choice: "required"` into a per-prompt rule
("You MUST call at least one tool") causes the model to call `bash()` for
non-actionable prose questions.

**Evidence.** Same run as F2. Variant `tool_choice_req`, n=1 per prompt:
- 3/5 useful responses (down from 5/5 baseline)
- "what is 7*8" → `bash()` call (FALSE_TOOL)
- "largest planet" → `bash()` call (FALSE_TOOL)

**Confidence.** High on the failure mode (2/2 prose questions broke). Low on
the magnitude — only 2 prose prompts in the suite.

**Falsification.** Repeat with 5+ prose prompts at `--repeat 3`. If
FALSE_TOOL rate stays >20%, claim holds.

**Action.** Documented; no code change. We still pass the OpenAI semantics
through as advisory text. We don't enforce it server-side.

---

### F4 — Synthetic `reply()` tool routes prose through the tool channel 🟢

**Claim.** Injecting a `reply(text)` synthetic tool makes the model emit
prose answers as `reply()` calls (which the handler converts back to plain
text).

**Evidence.** Same run as F2, variant `with_reply`, n=1 per prompt:
- 3/3 tool prompts → correct tool call
- 2/2 prose prompts → `reply(...)` call (OK_REPLY)

**Confidence.** Medium — works on this run, but only n=1 for each prose
prompt. The most actionable benefit ("never breaks the agent loop with
stray prose") is a 1-trial observation.

**Falsification.** Run `--variants with_reply --repeat 5` on a suite of 10
prose prompts. If the prose→`reply()` route fails >10%, claim weakens.

**Now available.** `M365_INJECT_REPLY_TOOL=1`. Code:
`packages/core/src/tools.ts::maybeInjectReplyTool`.

---

### F5 — No public REST endpoint exposes token usage 🟡

**Claim.** Token-count data is not reachable via any obvious REST sibling
endpoint of the chat WS.

**Evidence.** `usage-endpoint-hunt.mjs` June 9 run, 24 URLs probed across
three tokens (Sydney, Power Platform, BAP).
- Sydney (15 paths): **all 500, empty body** — suspicious. Either paths
  don't exist or path discovery is gated by browser headers (`Origin`,
  full `User-Agent`) which the WS upgrade requires but our REST GETs
  didn't send.
- PP (6 analytics-shaped paths): **all 404** — paths do not exist for our
  Starter licence.
- BAP (3 governance paths): **all 404**.

**Confidence.** Low. The Sydney 500s are not a clean "doesn't exist" signal.
Re-running with the full browser header set is required before declaring
token usage genuinely unreachable.

**Falsification.** Re-run `usage-endpoint-hunt.mjs` with
`Origin: https://m365.cloud.microsoft` and the WS client's `User-Agent`.
If anything returns 200/4xx (not empty 500), the surface exists.

**Raw data.** `usage-endpoint-out/2026-06-09T07-09-42-663Z/results.json`.

---

### F6 — Disengaged didn't fire in 30 attempts including jailbreak framing 🟡

**Claim.** Across all 30 compliance-experiment turns + 2 deliberately
Disengage-shaped probes, M365 returned content. No `messageType: "Disengaged"`
was observed.

**Evidence.** 30 turns in `tool-compliance-out/2026-06-09T07-04-46-817Z/`
(meta.disengaged = 0) + 1 turn in `frame-dump-out/...-disengage/` (12 tools
+ `STRICT RULES: never describe your intent. Output ONLY JSON.`).

**Confidence.** Medium that the agent + our prompts don't disengage under
the prompts we tried. Low that this generalises — we never sent content the
classifier should actually find offensive.

**Falsification.** Run an explicit calibration probe with progressively
more aggressive prompts (e.g. add `OFFENSIVE_CONTENT_REDACTED` tokens
known to trip Microsoft's classifiers) and confirm `Disengaged` fires at
some `dea_violation` level. Threshold currently bounded only as
`> 2.2 × 10⁻³`.

**TODO probe.** `scripts/disengaged-calibration.mjs` (not yet written —
see §7).

---

### F7 — Diagnostic fields exposed through the runtime 🟢

**Claim.** Bot messages and `type:2` items carry `scores`, `turnCount`,
`turnState`, `contentOrigin`, `messageType`, `messageId`,
`conversationExpiryTime`, `result.serviceVersion`,
`gptIdentifiers[].compliantAgentName`. We now parse and surface them.

**Evidence.** All visible in any `frame-dump-out/.../raw-frames.ndjson`.

**Confidence.** High on existence (every capture shows them). Medium on
exact semantics — we infer from the values, not from Microsoft docs.

**Now exposed.** Through `CopilotStream` and `usage.x_m365_*`. Code:
`packages/core/src/{copilot,session,schemas}.ts`,
`packages/proxy-lib/src/handler.ts`.

---

### F8 — Things we saw but haven't dug into 🔴

| Field | Decoded value | Hypothesis |
|---|---|---|
| `conversationTransferToken` | base64(`{"type":"FullConversation","conversationId":"<uuid>"}`) | Possibly a handle for migrating a conversation across hosts/sessions — could side-step the 600-msg-per-conv cap. Mechanism unknown. |
| `result.serviceVersion` | `1.0.03443.34112` | M365 service build under test. Capture in every probe for reproducibility. |
| `conversationExpiryTime` | ~30 days out | Conversations auto-expire. Could explain "I came back next month and it doesn't remember" reports. |
| `telemetry.userMessageRequestStartTime` | always null | Probably gated by a feature flag in `variants`. The `variants-bisect.mjs` probe is the right tool. |
| `firstNewMessageIndex` | `1` in our captures | Could power smarter delta sends — only forward messages from this index. |

---

### Summary as one table

| ID | Claim | Conf | n | Action shipped |
|---|---|---|---|---|
| F1 | Classifier scores in responses | High | 8 captures, 3 prompt shapes | Score in `usage{}` |
| F2 | Few-shot is dead weight | Med | 5×1 | Off by default |
| F3 | `tool_choice:"required"` is harmful | High | 2×1 prose | Documented; no enforcement change |
| F4 | `reply()` injection routes prose | Med | 2×1 prose | `M365_INJECT_REPLY_TOOL=1` |
| F5 | No REST token-usage endpoint | Low | 24 URLs | None — needs re-probe with headers |
| F6 | Disengaged didn't fire | Med | 32 turns | None — needs calibration probe |
| F7 | Diagnostic fields available | High | every turn | Parsed & surfaced |
| F8 | Unexplored fields | Untested | n/a | TODO probes |

---

## 1. Tool-call compliance — what actually moves the needle?

The agent's server-side system prompt is the only confirmed lever (
[`m365-copilot-api.md`](m365-copilot-api.md) §10). Open questions about how
to nudge it further. **All results are n=1 per cell** unless re-run with
`--repeat`; see §M caveat 1.

| # | Hypothesis | Status | Probe |
|---|---|---|---|
| 1.1 | Injecting a synthetic `reply(text)` tool makes every turn a tool call, eliminating the "answered in prose, broke the loop" failure mode. | 🟢 **Confirmed** (June 9). 5/5 compliance, both prose Qs went through `reply()` cleanly. Gated by `M365_INJECT_REPLY_TOOL=1`. | `--variants with_reply,baseline` |
| 1.2 | A softer (no ALL-CAPS) instruction set gets the same compliance. | 🟡 **Equivalent compliance** (5/5) but introduced stray text on 2/3 of tool calls. Not worth the swap. | done |
| 1.3 | The few-shot helps for reasoning-derailed tones, but adds tokens to the prompt for everyone. Without it, baseline tones might already comply. | 🟢 **Disproved usefulness** (June 9). 5/5 compliance AND fastest variant (4.9s vs 5.4s baseline). **Few-shot removed from default path**, restore with `M365_KEEP_FEWSHOT=1`. | done |
| 1.4 | If the agent enforces the format server-side, the per-request prompt only needs `<tools>` + the user message. The strict rules block is redundant noise (and Disengaged-risk). | 🟢 **Confirmed** (June 9). `minimal` got 5/5. The agent's server-side prompt is load-bearing; the rest is mostly hedge. We could go further on prompt simplification. | done |
| 1.5 | `tool_choice: "required"` (translated into a prompt rule) flips behaviour vs. `auto` — confirms whether the model can answer in prose at all. | ⚫ **Disproved as a win** (June 9). Drops to 3/5 — forces invalid `bash()` calls on "what is 7×8?" type prose. Active foot-gun; honor the OpenAI semantics defensively. | done |
| 1.6 | Disengaged threshold scales with tool **count**, not total prompt size. Halving descriptions but keeping 12 tools = still disengages. | 🟡 **Untestable as written** (June 9) — 12 tools no longer disengage at all. Need a calibration probe to find the new threshold. | (TODO: disengaged-calibration probe) |
| 1.7 | `inputMethod: "Agent"` (instead of `"Keyboard"`) might bypass a "chat assistant" classifier that biases toward prose. | 🔴 still untested. Cheap single-field flip — combine with score capture to see if it lowers `dea_violation`. | `scripts/frame-dump-probe.mjs --allowed-extra` is the lab; add a `--input-method` flag if it pans out. |
| 1.8 | `experienceType: "Agent"` / `"BizChatAgent"` / `"Programmatic"` may exist as an enum value that shifts routing. | 🔴 still untested. Same cheap probe. | study `studio-dig.mjs` capture for the values the real UI sends. |

---

## 2. Token usage — what M365 actually exposes

### What we know for sure (🟢)
- M365 sends a `ThrottlingUpdate` frame with **per-conversation user-message
  counts** (`numUserMessagesInConversation` / `maxNumUserMessagesInConversation`,
  default cap = 600).
- It also sends `numLongDocSummaryUserMessagesInConversation` (always 0 in our
  traffic — probably gates "Summarize this doc" calls separately).
- The OpenAI WebSocket API analog returns full token usage; M365's SignalR
  protocol does **not** in any frame we currently capture.

### What we hunted (June 9 2026)
| # | Hypothesis | Result |
|---|---|---|
| 2.1 | Some frames carry a `usage` / `tokenCount` / `contextLength` field but we don't parse them. | ⚫ **Disproved** — `frame-dump-probe.mjs` walked every key of every frame in the typical-conversation flow. No `token*`, `usage*`, `contextLength*`, `cost*`, `metering*` keys found. What we DID find (and now parse): `scores`, `turnCount`, `turnState`, `conversationExpiryTime`, `conversationTransferToken`, `result.serviceVersion`, `gptIdentifiers[].compliantAgentName`. |
| 2.2 | Adding `TokenUsage` / `Telemetry` / `Diagnostics` / `Usage` to `allowedMessageTypes` unlocks an extra frame type. | ⚫ **Disproved** — probe asked for all of them. M365 silently ignored unknown types. |
| 2.3 | `DeveloperLogs` (already allowed but never observed in traffic) needs a paired feature flag in `variants` or `optionsSets` to switch on. | 🔴 Still untested. The `variants-bisect.mjs` probe is the right tool. |
| 2.4 | A REST sibling endpoint under `substrate.office.com/sydney/v1/me/usage` (or similar) returns aggregate token usage. | 🟡 **Possibly** — every Sydney URL we tried returns empty 500 (vs PP/BAP cleanly 404ing). Sydney might gate path discovery on the full browser header set the WS endpoint requires. Probe with full Origin/User-Agent next. |
| 2.5 | The Power Platform `analytics` API (`<env>/analytics/...`) has per-agent metrics. | ⚫ **404** on every analytics path. |
| 2.6 | The `m365.cloud.microsoft` web UI surfaces a "messages remaining" badge somewhere — that badge has to source from a frame we already see. Worth tracing in devtools. | 🔴 Manual; not done yet. |

### What we should surface today (🟢 implemented)
The **conversation quota** is the cleanest proxy for "context-window
utilisation %". The proxy now exposes it through the OpenAI `usage` block as
extension fields. Clients that ignore unknown keys keep working; curious users
get visibility.

```json
{
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0,
    "x_m365_conversation_messages": 42,
    "x_m365_conversation_max": 600,
    "x_m365_conversation_pct": 7,
    "x_m365_conversation_remaining": 558,
    "x_m365_content_origin": "3PDeclarativeAgent",
    "x_m365_message_type": null
  }
}
```

Useful both for debugging ("are we about to hit the 600 cap?") and for
distinguishing the agent path (`3PDeclarativeAgent`) from the reasoning path
(`DeepLeo`) without parsing the body.

---

## 3. Context-window % — what it actually means

OpenAI clients use "context window" to mean **prompt-token budget**. M365 has
no analog we've found — model identity is hidden behind the `tone` setting,
and no frame admits to a context length.

What M365 *does* enforce is a **conversation-level cap**: 600 user messages
per `ConversationId`. So "context-window %" here translates to
*"conversation-quota %"* — `numUserMessagesInConversation /
maxNumUserMessagesInConversation`.

This isn't the same axis (tokens vs. messages) but it's the only budget the
server enforces and tells us about. The proxy surfaces it via the `usage`
block (above). If/when we find a real token-window field via §2's probes, we
can layer that in too.

---

## 4. Frame surface area — fields we're dropping

Things we've seen in `BotMessage` but currently don't surface:

| Field | What it is | Why we'd want it |
|---|---|---|
| `contentOrigin` | `3PDeclarativeAgent` / `DeepLeo` / etc. | Tells us which back-end routed the request. Now surfaced via `x_m365_content_origin`. |
| `messageId` / `responseIdentifier` / `requestId` | Server-assigned IDs | Telemetry correlation; logged + surfaced. |
| `messageType` | `Disengaged` / `EndOfRequest` / control types | Final answer's type. Useful for clients to detect Disengaged from outside. |
| `sourceAttributions` | Bing search hits etc. | Could surface as citation metadata when the user enables web browsing. |
| `suggestedResponses` | Quick-reply suggestions | OpenAI-ish equivalent could be `metadata.suggestions`. |

The `scripts/frame-dump-probe.mjs` script writes ALL fields we observe to
`scripts/frame-dump-out/<ts>/keys-summary.json` so the next dig finds new ones
without code changes.

---

## 5. The "Disengaged" filter — open questions

| # | Hypothesis | Status |
|---|---|---|
| 5.1 | Disengaged is purely classifier-driven; **prompt content** matters more than tool count once you're under the size cap. | 🟡 — partially seen in lean-toolset success. |
| 5.2 | A specific feature flag in `variants` enables the filter — turning it off via a flag flip is possible. | 🔴 — try diff'ing `variants` minimal vs. full. |
| 5.3 | Disengaged returns extra hidden meta in fields we don't parse (e.g. `offense`, `hiddenText`, classifier scores). | 🟡 — `offense` and `hiddenText` are partially visible in schemas, but never surfaced. Worth dumping with the probe. |

---

## 6. Cost / metering — does Microsoft tell us?

| # | Hypothesis | Status |
|---|---|---|
| 6.1 | The `licenseType: "Starter"` field affects metering. Setting `"Enterprise"` (etc.) might unlock different model tiers or higher caps. | 🔴 |
| 6.2 | The `chargeable: true/false` flag (or similar) might appear on `EndOfRequest` frames once we expand `allowedMessageTypes`. | 🔴 — frame-dump probe will catch this. |
| 6.3 | `https://api.bap.microsoft.com/.../consumption` or `.../usage` endpoint may surface token-equivalent metering at the tenant level. | 🔴 — separate probe. |

---

## 7. Probe backlog (ordered by expected information gain ÷ cost)

| Status | Probe | What it does | Cost | Confirms / falsifies |
|---|---|---|---|---|
| 🟢 | `scripts/usage-endpoint-hunt.mjs` | Sweep Sydney/PP/BAP REST endpoints for token usage. | 0 msgs (GETs) | F5 (currently low-confidence) |
| 🟢 | `scripts/variants-bisect.mjs` | Bisect the 40-flag `VARIANTS` list to find which one(s) control Disengaged / streaming mode. | ~10 msgs/target | F6, §5.2 |
| 🟢 | `scripts/frame-dump-probe.mjs` | Dump every field of every frame and flag token/usage candidates. | 1 msg | Catch newly-added M365 fields |
| 🟢 | `scripts/frame-dump-disengage.mjs` | Targeted Disengage-shaped probe. | 1 msg | F6 |
| 🟢 | `scripts/tool-compliance-experiment.mjs --repeat N` | Statistical version of the compliance A/B. | 30N msgs | F2, F3, F4 with real error bars |
| 🔴 | `disengaged-calibration.mjs` | Progressively more aggressive prompts to find the `dea_violation` threshold where Disengaged fires. | ~10 msgs | Bound F6 to a real threshold |
| 🔴 | `usage-endpoint-hunt-v2.mjs` | Same as v1 but with full browser headers (Origin/User-Agent/Accept-Language). | 0 msgs (GETs) | F5 properly |
| 🔴 | `inputmethod-experiment.mjs` | Flip `inputMethod` (`Keyboard`/`Voice`/`Agent`?) and `experienceType` enums, watch dea_violation. | ~5 msgs | §1.7, §1.8 |
| 🔴 | `tone-comparison.mjs` | Repeat the compliance experiment across every `MODEL_TONES` value to test whether F2–F4 generalise off `magic`. | ~50 msgs | Generalisation of F2-F4 |
| 🔴 | `transfer-token-probe.mjs` | Try to POST `conversationTransferToken` to various Sydney paths to see if a conversation can be migrated. | ~5 msgs | F8 (the 600-msg-cap workaround) |
| 🔴 | `admin-portal-dig.mjs` | Playwright-drive Microsoft 365 admin's Copilot usage page; capture the API call that returns the dashboard data. | 0 msgs (UI only) | F5 |

### Recommended next session

1. **disengaged-calibration.mjs** (cheap, bounds the most useful metric).
2. **tool-compliance with `--repeat 5`** (turns F2's "10% faster" into a
   real comparison — currently below the noise floor).
3. **usage-endpoint-hunt-v2.mjs** with full browser headers (F5
   re-investigation).
