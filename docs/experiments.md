# Experiments — a runnable catalog

Reusable experiments for this project. Each is a **hypothesis + an exact way to
run it + how to read the result**. This is the "press go" layer; the messy
thinking lives in [`hypotheses.md`](hypotheses.md), confirmed facts in
[`m365-copilot-api.md`](m365-copilot-api.md).

> **Science discipline (see `AGENTS.md`):** change ONE variable, give it a
> `--label`, record the number. Don't trust small differences at `n=1` — use
> `--repeat`. **Run comparative experiments on a RESTED account** — degradation
> (api doc §7) makes `Disengaged` look like a format/prompt failure and poisons
> A/Bs. Pace requests; if `Disengaged`/empty spikes across *fresh* conversations,
> stop and wait ~15 min.

## Setup

```sh
pnpm build && pnpm run proxy 4141          # one shell; add env flags per experiment
# probes: M365_NO_INTERACTIVE=1 CHROMIUM_PATH=$(which chromium) node scripts/<probe>.mjs
# bench:  node scripts/bench/run.mjs --base-url http://localhost:4141/v1 --model <id> --label <name>
```

Bench scorecards land in `scripts/bench/out/<label>-<ts>.json` — diff them.

---

## A. Tool-call compliance — the headline problem (baseline: 0/5, §8.12)

The model prose-hallucinates instead of emitting tool JSON. Goal: any config that
gets a non-zero `SOLVED` / tool-call rate. **Always diff against the magic baseline.**

### E-C0 — Re-baseline (run first, on a rested account)
- **Why:** the `0/5` was measured while degraded; confirm it holds when fresh.
- **Run:** `node scripts/bench/run.mjs --model m365-copilot --label baseline --repeat 2`
- **Read:** `SOLVED %` + outcome mix. If still ~0 with few disengages → the prose
  failure is real (not throttle). If disengages vanish but prose stays → confirms
  the two failure modes are independent.
- **Cost:** ~25–50 msgs.

### E-C1 — Fenced format vs JSON  ⭐ (needs code first)
- **Hypothesis (H4):** the model emits ` ```bash `/` ```edit ` blocks far more
  readily than `{"tool":...}` JSON (training-grain + no escaping). Higher SOLVED,
  fewer GAVE_UP_PROSE.
- **Build:** add `M365_TOOL_FORMAT=fenced` — extend `parseToolCalls` (tools.ts) for
  fence-lang→tool + SEARCH/REPLACE edits, and a fenced variant of
  `getAgentInstructions` (agent.ts). Editing instructions → new agent hash → fresh
  agent auto-provisioned.
- **Run:** baseline `--label json`; restart proxy with the flag → `--label fenced`.
- **Read:** SOLVED(fenced) − SOLVED(json). >0 confirms; design note in api doc §5.
- **Cost:** ~25 msgs/arm.

### E-C2 — Task-type sensitivity
- **Hypothesis:** fakeable tasks (fizzbuzz, count-lines) hallucinate success;
  unfakeable tasks (find-needle, fix-bug, edit-config) disengage. Compliance
  depends on whether the model *can* fake an answer.
- **Run:** `--tasks fizzbuzz,count-lines --label fakeable` vs
  `--tasks find-needle,fix-bug,edit-config --label unfakeable`.
- **Read:** outcome mix per group. Confirms the §8.12 pattern; tells us whether
  "force a tool" framing should target fakeable tasks specifically.
- **Cost:** ~15 msgs.

### E-C3 — Anti-hallucination framing
- **Hypothesis:** a system/agent prompt that asserts the model has *no* prior
  knowledge of the sandbox ("the filesystem is unknown to you; you MUST inspect it;
  any claim about a file's contents without a tool_response is a hard error")
  lowers prose-hallucination.
- **Build:** variant of `getAgentInstructions` (or pass via the harness system
  prompt in `scripts/bench/run.mjs` `SYSTEM`).
- **Run:** bench A/B.  **Read:** SOLVED + prose-count delta.  **Cost:** ~25 msgs.

### E-C4 — `tool_choice` enforcement
- **Hypothesis:** sending `tool_choice:"required"` raises tool-call rate on
  actionable tasks (vs the false-bash foot-gun the docs found on prose questions —
  F3 — which the bench's tasks avoid, since all are actionable).
- **Run:** the bench always sends tools; add a flag to set `tool_choice` in the
  request, A/B.  **Read:** SOLVED delta.  **Cost:** ~25 msgs.

### E-C5 — Model comparison (agent path)
- **Hypothesis:** `gpt-5.5` (or `*-quick`) complies better than `magic` on the
  agent path. (Claude is **not** testable here — the agent forces GPT / disengages,
  §5; it's plain-chat only.)
- **Run:** `--model m365-copilot --label magic` vs `--model gpt-5.5 --label gpt55`
  vs `--model quick --label quick`.
- **Read:** SOLVED per model.  **Cost:** ~25 msgs/model.

---

## B. Throttle / degradation (api doc §7)

### E-T1 — Characterise the throttle  (`scripts/throttle-probe.mjs`)
- **Hypothesis (H8.20):** account degradation is request-rate (RPM) driven with a
  recovery window — staying under some RPM avoids it.
- **Run:** `M365_NO_INTERACTIVE=1 CHROMIUM_PATH=$(which chromium) node scripts/throttle-probe.mjs --rpm 30 --max 25 --recover`
  Sweep `--rpm 10 / 30 / 60 / 120`.
- **Read:** request index where `Disengaged`/empty onset begins per RPM, and the
  recovery delay. Output → a safe client-side pacing config (requests/min the proxy
  should self-limit to).
- **Cost:** up to `--max` msgs/run (bursty by design).

### E-T2 — Is degradation grounding-path dependent?
- **Hypothesis (H8.8):** tenant-graph-grounded turns degrade sooner than ungrounded
  ones. (Pairs with E-O1's search toggle.)
- **Run:** throttle-probe with `plugins:[]` vs default Bing; compare onset.
- **Cost:** bursty.

---

## C. License-free capability unlocks (optionsSets — §8.1)

All run with `scripts/_probe-chat.mjs` overrides; no license needed.

### E-O1 — Web-search toggle (H8.9)
- **Run:** a probe sending `plugins:[]` + `optionsSets:["nosearchall"]` vs default;
  same fresh-fact question.  **Read:** `InternalSearchQuery` frames + latency only
  in the search-on arm.  **Cost:** ~4 msgs.

### E-O2 — Memory / custom-instructions (H8.14)
- **Run:** `optionsSets:["add_custom_instructions","update_memory_plugin",
  "enable_inferred_memory_read"]`; turn 1 plant a code word, NEW conversation ask
  for it.  **Read:** recalled across conversations vs not.  **Cost:** ~3 msgs.

### E-O3 — Image input (H8.10)
- **Run:** POST a PNG to the substrate `UploadFile` endpoint (see PyRIT), attach
  `messageAnnotations`, ask "what's in this image?".  **Read:** pixel-level vision
  vs filename echo.  **Cost:** ~3 msgs.  **Needs:** the upload-flow probe.

### E-O4 — Code interpreter regression (already wired)
- **Run:** `node scripts/code-interpreter-probe.mjs` — SHA-256 oracle.
- **Read:** correct digest = real Python.  **Cost:** 1 msg. Use as a smoke test
  that the agent-less optionsSets path still works after changes.

---

## D. Limits / regression (confirmed once — re-run to catch M365 changes)

### E-L1 — Input ceiling / retrieval depth (F9/F10)
- **Run:** `node scripts/input-size-bisect.mjs` ; `code-interp-egress`-style needle
  tests.  **Read:** still ≥500k-token accept, dispersed-fact recall, benign size
  never disengages.  **Cost:** ~6 msgs.

### E-L2 — Output ceiling (F9)
- **Run:** essay word-target probe (output-ceiling-probe is integer-only; use an
  incompressible task).  **Read:** still wraps ~3k tokens.  **Cost:** ~2 msgs.

### E-L3 — Disengaged tool-count threshold (F6)
- **Hypothesis:** find the tool-count at which a *clean* (non-jailbreak) tool block
  disengages. Note: §8.12 showed tool *count* doesn't change the 0-compliance, but
  the disengage threshold is a separate axis.
- **Run:** `frame-dump-probe.mjs --many-tools` style, escalating tool count, watch
  `dea_violation` + `messageType`.  **Cost:** ~1 msg/step.

---

## Adding an experiment

1. State the hypothesis + falsification criterion in `hypotheses.md`.
2. Add a runnable recipe here (commands + readout + cost).
3. Reuse `scripts/_probe-chat.mjs` (qualitative) or `scripts/bench/` (quantitative).
4. Record the result back in `hypotheses.md` with sample size + evidence pointer.
