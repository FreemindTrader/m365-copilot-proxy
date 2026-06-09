# Reverse-engineering hypotheses & experiments

A live notebook of things we've **guessed**, things we've **tested**, and the
levers each one gives us. Update as we learn. The companion API doc
([`m365-copilot-api.md`](m365-copilot-api.md)) is for confirmed protocol
behaviour; this is the messy "we haven't shipped it yet" layer.

Status legend: 🟢 confirmed · 🟡 partially tested · 🔴 untested guess ·
⚫ disproved.

---

## 0. Headline findings from the June 9 2026 dig

These are the things we now know, with data:

1. **M365 sends classifier scores in every response.** `BotOffense` and
   `dea_violation` arrive on every bot message in `update` and `type:2`
   frames. The `dea_violation` component is the disengagement classifier —
   surfacing it lets us measure proximity to Disengaged without actually
   tripping it. Now plumbed through `usage.x_m365_dea_score`. Empirical
   ranges from our captures:

   | Prompt shape | BotOffense | dea_violation |
   |---|---|---|
   | Clean prose ("pong") | 1.3 × 10⁻⁷ | 2.8 × 10⁻⁶ |
   | Clean lean tool call | 2.2 × 10⁻¹³ | 2.1 × 10⁻⁸ |
   | 12-tool jailbreak-framed | 1.2 × 10⁻³ | 2.2 × 10⁻³ |

   Tool-shaped output is 9–10 orders of magnitude safer in the classifier's
   view. Disengaged didn't fire at 2.2 × 10⁻³ — threshold is higher than
   that; needs more aggressive probing to pin down.

2. **The few-shot we were sending is dead weight.** Tool-compliance
   experiment (June 9): `no_fewshot` variant got 5/5 perfect AND was 10%
   faster than baseline. Removed from the default prompt path; restore with
   `M365_KEEP_FEWSHOT=1`. ~250 tokens saved per request.

3. **`tool_choice: "required"` is harmful.** It made the model call `bash()`
   for "what is 7×8?" — 3/5 compliance vs. baseline 5/5. Do not propagate it
   verbatim into the prompt as we currently do; treat it as advisory.

4. **The `reply()` synthetic tool works as intended.** The `with_reply`
   variant routed both pure-prose questions through `reply()` calls (5/5
   total compliance). Available behind `M365_INJECT_REPLY_TOOL=1`.

5. **No public REST endpoint exposes token usage.** All 24 candidate URLs
   across Sydney, Power Platform, and BAP returned 500 (Sydney) or 404
   (PP/BAP). The Sydney service appears to deny unfamiliar paths with empty
   500s — possibly recoverable by sending the full browser header set, but
   that's another probe.

6. **Disengaged didn't fire ONCE in 30 chat turns** including 12-tool +
   jailbreak-framed prompts. Either Microsoft eased the filter, our agent's
   server-side prompt protects us, or we need genuinely abusive content to
   trip it. Worth a calibration probe.

7. **New fields surfaced through the runtime** — `scores`, `turnCount`,
   `turnState`, `contentOrigin`, `messageType`, `messageId`. All now in the
   `usage{}` extension block of every chat completion.

8. **Untested but interesting:** `result.serviceVersion`,
   `conversationExpiryTime` (≈30 days), `conversationTransferToken` (a
   base64 blob whose decoded prefix is `{"type":"FullConversation",...}` —
   maybe a way to migrate a conversation across hosts/sessions and
   side-step the 600-message cap).

---

## 1. Tool-call compliance — what actually moves the needle?

The agent's server-side system prompt is the only confirmed lever (
[`m365-copilot-api.md`](m365-copilot-api.md) §10). Open questions about how
to nudge it further:

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

## 7. New probes to write

| Status | Probe | What it does |
|---|---|---|
| 🟢 | `scripts/usage-endpoint-hunt.mjs` | Sweep Sydney/PP/BAP REST endpoints for token usage. |
| 🟢 | `scripts/variants-bisect.mjs` | Bisect the 40-flag `VARIANTS` list to find which one(s) control Disengaged / streaming mode. |
| 🟢 | `scripts/frame-dump-probe.mjs` | Dump every field of every frame and flag token/usage candidates. |
| 🟢 | `scripts/tool-compliance-experiment.mjs` | A/B over prompt variants for tool-call compliance. |
| 🔴 | `admin-portal-dig.mjs` | Playwright-drive Microsoft 365 admin's Copilot usage page (`admin.microsoft.com/.../copilot/usage`); capture the API call that returns the dashboard data. |
| 🔴 | `inputmethod-experiment.mjs` | Flip `inputMethod` and `experienceType` through plausible enum values and watch compliance/Disengaged rate. |
