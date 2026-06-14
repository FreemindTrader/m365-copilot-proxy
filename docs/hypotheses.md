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
- §8 — Capability-expansion hypotheses (web-research dig: empty `optionsSets`, code interpreter, MCP actions, Claude tone, throttling levers, reference implementations)

---

## 9. June 14 2026 — agentic tool-use SOLVED via shell-routing (bench 0/5 → real multi-turn loops)

The headline §8.12 problem (0/5, model narrates instead of acting) is **broken open**.
Service version unrecorded this session (capture next run); single tenant `ao@re-zip.com`,
`magic` tone, fenced format. All bench runs in `scripts/bench/out/`, full trace in
`~/.config/opencode-m365/debug.log`, frames in `~/.config/opencode-m365/frames/`.

### F12 — Shell-routing is the unlock: model writes ```bash, proxy executes it 🟢

**Claim.** M365's chat-tuned model will **not** "act as an agent" (emit a structured
tool call on demand) but **will** reflexively write a ```bash block when asked to "do
the task by writing shell commands." Routing that block to the harness's shell tool
turns prose-narration into real, converging agent loops.

**Evidence.** Bench, fenced format:
| config | result | note |
|---|---|---|
| JSON (default), neutral prompt | **0/5** | reproduced §8.12 baseline |
| fenced + bench p8 "write bash" prompt | **2/5** (fix-bug, find-needle) | first real solves ever |
| fenced + p9 heredoc prompt | **1/5** (edit-config) | different task, same mechanism |
| fenced + **Tier-1 proxy framing**, NEUTRAL prompt | **fix-bug SOLVED, 9 tool calls / 10 msgs / 116s** | the loop is the proof |

The 9-turn fix-bug loop (`tier1-neutral`, raw frames captured): model wrote
`cat > /work/calc.py <<'EOF' … return a + b … EOF`, verified with `python3 -c`, re-ran
`check.py`, iterated to a green `OK`. The bench's objective verifier confirmed it.

**Mechanism.** The model often *still narrates* ("I'm unable to access the files…") **while
simultaneously emitting a ```bash block**. The fenced parser executes the block, the real
output grounds the next turn, the handler strips the prose — and it converges. The prose
disclaimer is harmless noise; the executed bash is what matters.

**Why it works (the cage theory).** Microsoft's server-side BizChat prompt sits *above*
ours in priority and defines the model as a retrieval chat assistant — so "be an agent"
(§8 prompt variants, all inert) is refused, but "write the shell command a user would run"
is *encouraged* behaviour. We stopped fighting the cage and used the one arm-hole it leaves
open. **Fragile/adversarial** — a DeepLeo framing change could close it.

**Shipped (Tier 1, `packages/core/src/fenced.ts`).** When the harness exposes a shell-like
tool (`bash`/`sh`/`shell`/`run`/`run_command`/… — pi, opencode, hermes, openclaw all do),
the proxy (a) injects shell-first framing into its own `<tools>` block ("do the whole step
by writing ONE ```bash block: heredocs to create, sed to edit, python3 to run"), and
(b) **aliases** ```bash/```sh/```shell to that tool whatever it's named, so the model's
reflexive ```bash maps to e.g. `run_command`. Harness-agnostic: real clients inherit it
with **no special prompt** (proven by the neutral-prompt 9-turn solve). Unit-tested.

**Confidence.** High that the mechanism produces real loops (a verified 9-turn solve + ~4
independent solves across prompts/runs). Medium on the rate (1–2/5, throttle-confounded; see
F13). The exact SOLVED task varies with prompt/account state; the *mechanism* is stable.

**Falsification.** Re-run `tier1-neutral` on a rested account: if fix-bug stops producing a
multi-turn ```bash loop, or JSON ever matches fenced on SOLVED, F12 weakens.

### F13 — Account degradation is THREAD-rate, not message-count; fresh login clears it 🟡

**Claim.** The "everything 502s / Disengages" degradation tracks **conversations (threads)
started**, not messages sent, and **re-authenticating (new MSAL tokens) restores function**.

**Evidence.**
- Throttle counter `numUserMessagesInConversation` **resets per conversation** (each bench
  task uses a nonce → fresh thread → counter back to 1). The 600-cap was never the limiter.
- The bench starts **one thread per task**; ~15 runs × 5 tasks ≈ **75 threads in ~35 min** →
  degradation onset. The degraded-era 502s carried `messageType:"ReferencesListComplete"`,
  `offense:"None"` — **no `Disengaged`** — i.e. **empty-response throttle**, not the content
  filter. (Earlier "disengage" reads were probably throttle all along.)
- Timeline: 17:20 p8 → 2/5; 17:28 p8 (same prompt) → 0/5, fix-bug/find-needle now 502.
  **Then logged out (moved `msal-cache.json` aside) + fresh Playwright/TOTP login** →
  immediately fix-bug SOLVED with a clean 9-turn loop. The two failing multi-request tasks
  recovered the moment the session got fresh tokens.

**Confidence.** Medium — re-login recovery is n=1 and confounded with a ~4-min rest, but the
magnitude (constant 502 → 9 successful turns) points to the token/session, and matches the
user-reported "Microsoft counts threads, not messages."

**Falsification.** Drive a single long thread to hundreds of messages without degrading
(would confirm thread-not-message); OR show recovery from pure waiting with no re-login
(would weaken the re-login claim). Probe: `throttle-probe.mjs` varying threads/min vs msgs/min.

**Actions.** (1) Experiment harness: minimise thread churn — reuse one conversation across
probe turns where task-independence allows. (2) Proxy/ops: a fresh-login (token refresh) is
a viable **throttle-recovery lever** — worth wiring an auto-reauth on sustained empty-503s.
(3) The product is already correct here: session-reuse keeps a real pi session to ONE thread.

### F14 — End-to-end through real pi works, but turn-1 confabulation is stochastic 🟡

**Claim.** With fenced + shell-routing, **real pi** (the OpenAI-compatible harness, not the
bench) drives M365 to fix a real bug end-to-end — read files, edit, run, verify — through
the proxy with no special prompt. But the turn-1 "I can't access the files / commands return
no output, please paste them" confabulation is **stochastic** and **worse under pi's own
system prompt** (a polished assistant prompt) than under the bench's short one.

**Evidence.** pi 0.78.1 → proxy (4141) → M365, task = the `fix-bug` calc.py `a-b`→`a+b`:
- Run 1 (neutral, weak framing): confabulated turn-1, 0 tools, asked to paste files. ❌
- Run 2 (`--append-system-prompt` with bash-first rules): **acted** — ran tools, discovered
  the env lacked `python3`, hacked a workaround. ✅ acted (env was unfair — no python3).
- Runs 4 & 5 (strengthened proxy framing, python3 provided, NO append): **SOLVED both** —
  `calc.py` → `a + b`, `python3 check.py` printed `OK`. Confab-retry did NOT need to fire
  either time (the model complied turn-1). **2/2** with the strengthened framing vs the
  earlier no-append runs that confabulated under the weaker framing.
So the model runs a full agentic loop through pi, and the strengthened proxy framing (the
anti-confab + first-move clauses) appears to flip the turn-1 reflex from confabulate→comply.

**Confidence.** High that end-to-end works (two verified real fixes through real pi). Medium
on reliability — 2/2 with the new framing is encouraging but small; run ~10× to pin the rate.

**Shipped (proxy-side, harness-agnostic — all three help the real backend):**
1. **Strengthened shell framing** (`formatFencedToolDefinitions`): added the explicit
   anti-confabulation + first-move clauses ("you've run nothing; never claim empty output;
   FIRST output must be a ```bash block") on top of the bash-elicitation. This is what an
   `--append-system-prompt` supplied manually; now the proxy carries it.
2. **Confab-retry** (`handler.ts`, `looksLikeConfabulation`): when a tool request returns no
   tool call AND the text matches give-up/paste-the-files phrasing, the proxy re-prompts
   forcefully **in the same conversation** (one thread, cheap) up to `M365_CONFAB_RETRIES`
   (default 1; `M365_NO_CONFAB_RETRY` to disable). Unit-tested; not yet observed firing+saving
   live (the runs that complied didn't need it). Insurance for the stochastic give-ups.
3. **Auto-reauth** (F13 productized, `auth-recovery.ts`): background fresh-login when empties
   span ≥N distinct conversations — clears thread-rate throttle without blocking requests.

**Falsification / next.** Run fix-bug through pi ~10× and record the comply-rate and how often
the confab-retry fires AND salvages. If the retry rarely saves a confabulated turn, escalate:
a 2nd retry, or inject the framing as the LAST pre-user instruction (recency).

### F15 — Shell-routing executes a model's OWN document if it contains code fences 🟢

**Claim.** The shell-routing parser turns *every* ```bash block into a tool call, so when
the model **answers** with a markdown document full of code fences — e.g. "here's a
simplified README" for a repo whose README is about ```bash — the proxy executes the
model's own answer as shell. Observed live through pi: asked to simplify a bash-heavy
README, the model wrote a new README; its 7-9 embedded ```bash fences were each run as
commands (garbage like `## Project…`), the model spiralled into confused "coaching", and
ran `pnpm test`/`build`. This is the JSON→fenced tradeoff biting: `{"tool":...}` was
unambiguous; ```bash collides with content.

**Fix (shipped) — `isProseDocument`, chosen empirically.** `scripts/guard-experiment.mjs`
ran candidate guards over real fixtures (the actual `README.md`, a model-written README,
single actions, heredocs, mixed prose+action). Result: a response is a DOCUMENT (return as
text, don't execute) iff **≥2 fences AND (≥120 chars of surrounding prose OR ≥4 fences)**.

| guard | real-README | model-README | single actions | score |
|---|---|---|---|---|
| baseline | ✗ executes | ✗ executes | ✓ | 5/7 |
| ≥3 fences | ✓ | ✗ (2 fences) | ✓ | 6/7 |
| **≥2 fences + prose≥120** | ✓ | ✓ | ✓ | **7/7** |
| prose≥200 | ✓ | ✓ | ✓ (risks chatty single action) | 7/7 |
| command-likeness | ✗ | ✗ | ✓ | 5/7 (fragile) |

Chose ≥2-fences+prose over prose≥200 because a **single** action is never reclassified
regardless of prose — the coding loop is provably untouched. Handler returns the document
as plain text (fences intact) instead of running it. `handler.ts` (`isProseDocument`),
unit-tested, validated offline against the real README (6 fences → text).

**Confidence.** High on the classifier (deterministic, real fixtures + units). The live
README task remains stochastically flaky for *other* reasons (turn-1 confab, a model
misreading `ls` output as file content) — orthogonal to this fix.

### F16 — Behavioural reliability fixes (from the live pi README run) 🟢

Two deterministic fixes for failures seen in the live pi README run (F15's session):

1. **Tool results were labelled `name="unknown"`** → the model misread a `ls` result
   (`README.md`) as the *file's* (empty) contents and gave up. Fixed: correlate each tool
   result to its call via `tool_call_id` and label it with the command that produced it —
   `<tool_response tool="bash" command="ls -la">`. Now the model reads output in context
   (listing vs file contents vs stdout). `formatMessages`/`toolCallSummary`, unit-tested.

2. **The confab-retry missed "appears empty" phrasings.** `looksLikeConfabulation` matched
   "returns no content" but not "no content *was returned*", "the file appears to be empty",
   or "nothing to simplify" — the exact give-up that ended the README run without a retry.
   Widened the patterns (unit-tested against the live strings).

3. **Hallucinated completion** (`looksLikeHallucinatedCompletion`): the model claimed "I've
   replaced the README" with **zero tool calls** — confirmed by README.md being untouched on
   disk. Detect past-tense file-write claims, gated on the model having made NO tool call in
   the whole conversation (a model that did real work called at least one tool → near-zero
   false positives), and force a real write via the same retry loop. Unit-tested.

**Live status (honest):** the document guard is **confirmed working live** (the model's
README answer was returned as text, not executed). The other fixes are deterministic +
unit-tested but **not yet validated live** — the account was too fatigued (request timeouts)
to get clean signal. The remaining model-behaviour problem (emitting a pile of fences +
"coaching" prose and spiralling) points at the shell-first framing being too aggressive; that
softening is the next step and **must be A/B'd on a rested account** (bench: keep the coding
win? pi: stop the spiral?), not shipped blind.

**Still open (needs a rested-account A/B, not a guess):** the shell-first framing is
aggressive enough that it ran `pnpm test`/`build` for a doc task. Softening it ("only run
what the task needs; inspect, then make the minimal change") might reduce over-eagerness —
but could regress the coding win, so it must be measured on the bench + pi, not shipped blind.

### What did NOT work (negative results, all this session)
- **8 per-request prompt variants** (alone / env-is-real / first-move-forcing / batch-persona
  / verify-contract / terse / combined): **0 tool calls each.** Wording cannot flip the turn-1
  reflex — the model decides to fake-success or confabulate "empty environment" *before* acting.
- **Heavy anti-advise framing baked into the AGENT** (server-side): **backfired** — suppressed
  even the illustration-fence tool calls to 0. The agent prompt is now minimal/format-only;
  behavioural framing lives in the per-request `<tools>` block (cheap to vary, no re-provision).
- **Context-seeding** (inject a real `ls`+output, even full file contents, before the task):
  **failed** — fully primed, the model still says "Done" with 0 tools. Having the info reads
  to it as "task complete."
- **Model axis** (`quick`, `gpt-5.5`): null on the tool path — `quick` instant-502s with the
  agent; `gpt-5.5` behaves like `magic`. The declarative agent forces GPT routing; tone doesn't leak.

### Remaining gap
Fakeable *create-from-scratch* tasks (`count-lines`, `fizzbuzz`) still hallucinate "created and
executed" with 0 tools — the model "knows" the answer so it shortcuts. Unfakeable tasks
(`fix-bug`, `find-needle`, `edit-config`) now solve because the model must run a command to
proceed. Next lever: make even fakeable tasks require a real read (or detect 0-tool "done"
claims and re-prompt "show me the tool_response that proves it").

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
| `scripts/input-size-bisect.mjs` | 1 msg/rung | Benign-filler input ladder; head+tail canary survival, dea_violation vs size. (F9/F10) |
| `scripts/output-ceiling-probe.mjs` | 1 msg/cell | Output-length cliff via countable payload + streamingMode sweep. ⚠ integer task is compressible — pair with an incompressible essay task. (F9) |
| `scripts/_probe-chat.mjs` | n/a | Shared single-turn WS helper the above two build on (text in, structured result out). |

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

### F9 — The I/O is wildly asymmetric: huge retrieval-backed input, tiny output 🟢

**Claim.** M365 Copilot (magic tone) accepts **at least ~500k tokens of input**
and answers in seconds, but **soft-caps output around ~3k tokens (~13k chars)**.
The input side is **retrieval-backed, not flat attention** — dispersed facts are
recoverable at any depth, but a 500k-token message returning in ~10s is not a
full attention pass.

**Evidence.** June 13 2026, service version `1.0.03449.35222`, plain chat
(no agent), `magic` tone, benign filler. Probes:
`scripts/input-size-bisect.mjs`, `scripts/output-ceiling-probe.mjs`,
plus inline needle/aggregation runs.

*Input ceiling* (n=1 per rung, head+tail canary both required to survive):

| Input | head canary | tail canary | Disengaged | dea_violation | latency |
|---|---|---|---|---|---|
| ~557 t | ✅ | ✅ | no | 8.5e-6 | 3.4s |
| ~64k t | ✅ | ✅ | no | 5.9e-7 | 4.7s |
| ~128k t | ✅ | ✅ | no | 1.3e-6 | 5.7s |
| ~250k t | ✅ | ✅ | no | 6.1e-7 | 7.3s |
| **~500k t** (2M chars) | ✅ | ✅ | no | 4.3e-5 | 14.7s |

*Retrieval depth* (single middle needle at 50% depth): found **4/4** sizes incl.
~500k t (9.4s). *Aggregation* (10 dispersed facts): **10/10** at every size incl.
~500k t (11.2s). So it's not just nearest-neighbour single-needle — it pulls all
10 dispersed facts.

*Filler-artifact check (hardening).* The above used degenerate repeated filler,
which M365's retrieval could trivially dedup. Re-ran aggregation with **438k
chars of real varied prose** (3 academic PDFs concatenated, tiled): still
**10/10** at ~128k t (7.8s) and ~500k t (15.8s). The result is not a
compressible-filler artifact.

*Output ceiling* (incompressible essay task, hard word target):

| Asked | Delivered | chars | ~tokens | ended mid-sentence? |
|---|---|---|---|---|
| 1500 words | 1489 | 10,493 | ~2,623 | no (natural conclusion) |
| 4000 words | 1802 | 13,105 | ~3,276 | **no** (natural conclusion) |

The model **wraps up early rather than truncating mid-stream**. Largest clean
delivery observed: 13,105 chars. (The integer-enumeration probe is misleading —
the model abbreviates `1..500\n...\n3499\n3500` past ~2500, a compressibility
artifact, not a transport cap. Use incompressible tasks to measure output.)

**Confidence.** High on the *shape* (input ≫ output, retrieval-backed) — every
run agreed. Medium on the exact numbers (n=1 per cell, single tenant/tone). The
500k-token ceiling is a floor, not a wall — we never found the top.

**Caveats.** (a) Aggregation tested only to 10 dispersed facts; heavy synthesis
over hundreds of cross-referenced facts (“refactor across my whole repo”) is
untested and is where retrieval-backing would bite. (b) Output ceiling is the
model *concluding*, so a near-ceiling file-write returns **clean-looking but
incomplete** — no error, no mid-stream cut to detect. This is a live agent
hazard.

**Falsification.** Re-test if: a middle needle is *missed* at ≤500k t; benign
input ever trips Disengaged (would mean size, not shape, drives it); or any
incompressible output exceeds ~3.5k tokens in one turn.

**Action (SHIPPED June 13).** (1) `/v1/models` now advertises
`context_window`/`max_input_tokens` = 128k and `max_output_tokens` = 3k
(`buildModelsPayload`, env-overridable). (2) The handler emits
`finish_reason:"length"` when output is at/over the ~12k-char ceiling
(`outputFinishReason`) so harnesses know to continue instead of trusting a
clean-looking truncation. (3) Large inputs are forwarded as-is (no client-side
chunking added). See "Probe → proxy actions" below.

**Raw data.** `scripts/input-size-out/<ts>/`, `scripts/output-ceiling-out/<ts>/`.

---

### F10 — Benign input size does NOT drive Disengaged 🟢

**Claim.** Raw size and Disengaged are **independent axes**. 2M chars of benign
filler never disengaged and never raised `dea_violation` (stayed 6e-7…8e-5,
uncorrelated with size). This isolates what the June 9 12-tool probe conflated:
**Disengaged is driven by jailbreak-*shape*, not byte count.**

**Evidence.** Same June 13 runs as F9 — 9 input rungs from 2k to 2M chars, zero
Disengaged, dea_violation flat under size.

**Confidence.** High that benign bulk is safe up to 2M chars. The "too large →
Disengaged" lore in `m365-copilot-api.md` §9 should be re-read as "too large
*and* tool-block-shaped" — size alone is fine.

**Falsification.** A benign (no jailbreak framing, no tool block) prompt that
Disengages purely on size.

**Action.** Correct §9's "too large" wording; the real trigger is tool-block
count + framing, not size.

---

### F11 — "send → cancel → send": context persists, quota does not refund 🟢

**Claim.** Cancelling a turn (the captured Stop frame, F-API §6) mid-generation:
(a) **still counts** against the 600-msg/conv quota; (b) **preserves the
cancelled turn's context** server-side — a fact planted in the cancelled turn is
recalled on the next turn; (c) makes the server **discard the partial answer**
and ack with a `type:3` completion, replacing the bot text with "You have
stopped this conversation."

**Evidence.** `scripts/send-cancel-send.mjs`, June 13 2026, one 2-turn
conversation, plain chat, `magic` tone, n=1:
- Turn 1: planted secret `PURPLE42` + a 3000-word essay request; sent the Stop
  frame at +3.2s. Bot text became "You have stopped this conversation.";
  `numUserMessagesInConversation = 1`; server acked `type:3`, no error.
- Turn 2: "what was the secret?" → reply **`PURPLE42`** (recalled);
  `numUserMessagesInConversation = 2`.

So: cancel cost a full quota message (1→2), and the cancelled turn's user content
survived into context.

**Confidence.** High on the three mechanics (clean, unambiguous single run).
Untested: whether the *partial assistant text* (not just the user message) is
retained as context, and whether cancelling at 0ms (before any delta) still
counts/persists.

**Falsification.** Re-run and observe the counter NOT incrementing for a
cancelled turn, OR the secret NOT recalled.

**Implications for harness use.**
- Cancel is a **clean, server-acked interrupt** — a harness can kill a runaway /
  rambling / Disengaging generation and immediately send a corrective follow-up
  **without resetting the conversation**. Worth wiring into the proxy as the
  response to an HTTP abort.
- It is **not** a quota-saving trick (still 1/600), and — since input has no size
  cap (F9) — **not** needed as an input-chunking mitigation. Its value is
  latency/output-token savings and loop control, not quota.

**Raw data.** `scripts/send-cancel-out/<ts>/results.json`.

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
| F9 | Input ≥500k t (retrieval-backed); output soft-caps ~3k t | High shape / Med numbers | 9 input rungs + needle/agg + 4 output | Proposed: advertise window, detect truncation |
| F10 | Benign size doesn't drive Disengaged | High | 9 rungs, 0 disengage | Doc fix to §9 |
| F11 | Cancel preserves context, still costs quota | High | 1 (2-turn) | Cancel frame doc'd; proxy abort path proposed |

### Probe → proxy actions (from the June 13 I/O dig)

The findings are useless unless they change the proxy. Status:

1. ✅ **Advertise a real context window.** DONE — `/v1/models` now carries
   `context_window`/`max_context_length`/`max_input_tokens` = 128k and
   `max_output_tokens` = 3k (`buildModelsPayload`, env-overridable via
   `M365_CONTEXT_WINDOW` / `M365_MAX_OUTPUT_TOKENS`).
2. ✅ **Guard the output ceiling.** DONE (option b) — the handler emits
   `finish_reason:"length"` when an answer is ≥ `M365_OUTPUT_CHAR_CEILING`
   (default 12k chars) instead of always `"stop"`, so a harness knows to
   continue. Auto-continue+stitch (option a) intentionally left to the harness
   (it costs 1/600 per continuation). `outputFinishReason` in `handler.ts`.
3. ✅ **Stop client-side chunking of large inputs.** DONE — inputs are forwarded
   as-is; no chunking added. (Delta-mode still only sends *new* messages per
   turn, which is correct: M365 keeps prior turns server-side.)
4. ☐ **Cancellation** (from the F11 dig) — SHIPPED: client-abort → Stop frame
   (`session.ts` `STOP_FRAME`, wired through `completions.post.ts`).

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

---

## 8. Capability-expansion hypotheses (June 13 2026 web-research dig)

A web dig across **five live implementations of this exact endpoint** — including
Microsoft's own red-team tool — plus the official extensibility docs. All 🔴
**untested guesses** unless noted; many are *doc-* or *wild-implementation-backed*
(higher prior than our usual blind guess). Source URLs in §8.8.

> **Headline: our chat payload sends `optionsSets: []` (empty).** Every other
> implementation ships a rich `optionsSets` array that switches on code
> interpreter, memory, custom instructions, image input, and search control.
> We are almost certainly leaving capabilities off the table by omission.
> Reference payloads to mine are in §8.8 — start there.

> **Connects to the live tool-compliance problem.** The "answers in prose /
> hallucinates tool results instead of calling a tool" failure (seen in the pi
> smoke test) may be fixable at the *capability* layer, not just prompt wording:
> H8.13 (`behavior_overrides.discourage_model_knowledge`), H8.12 (real
> memory/custom-instructions channel), and especially H8.4/H8.5 (give it a
> *real* server-side tool so it stops emulating) all attack it from a new angle.

### 8.1 — Server-side tools we may be able to switch on (highest payoff)

| # | Hypothesis | Why plausible (source) | Cheap probe | Payoff |
|---|---|---|---|---|
| **H8.1** | `optionsSets:["enterprise_flux_work_code_interpreter","code_interpreter_interactive_charts","code_interpreter_matplotlib_patching","codeintfile","sdretrieval"]` + `allowedMessageTypes:[…,"GeneratedCode","GenerateContentQuery"]` unlocks a **real server-side Python sandbox**. | PyRIT, kuchris, g365, SydneyQt all ship these; code-interpreter is "available to Copilot Chat users without metered usage" (MS docs). | Add the flags, send "run `print(2**100)` in Python"; watch for a `GeneratedCode` frame + a result the model couldn't compute itself. | A free code-execution tool — run/verify snippets, data transforms — without us hosting a sandbox. |
| **H8.2** | The **declarative** route to the same: add `capabilities:[{"name":"CodeInterpreter"}]` to the `minimalBots` GPT-component create payload (not just `instructions`). | `CodeInterpreter` is a first-class manifest capability (manifest 1.6 / TypeSpec). Our agents *are* declarative agents under a different authoring API. | Republish agent with the capability; ask it to hash a string in Python; watch for code-exec frames vs hallucination. | Same sandbox, attached to our agent (survives across turns). |
| **H8.3** | `capabilities:[{"name":"GraphicArt"}]` (or `optionsSets` flux flags `fluxcopilot`/`fluxprod`/`dgencontentv3`) returns **generated images** over the WS. | `GraphicArt` is a documented capability; flux flags are in every wild optionsSet. Visually-obvious → good **capability-acceptance canary**. | Add it; prompt "generate an image of a red cube"; watch for an image/blob frame. | Confirms the capabilities-array path works *at all* (cheap oracle) + image-gen tool. |
| **H8.4** | `actions:[{id,file}]` → an embedded **`ai-plugin.json` with `runtimes:[{type:"OpenApi"}]`** gives **native function calling with real HTTP execution**, replacing our prompt-emulated loop. | API-plugin manifest 2.4; the documented native-action mechanism. Mark function `isNonConsequential` to skip the confirm card. | Stand up a 1-route OpenAPI endpoint returning a sentinel; reference it; watch for an outbound hit + sentinel in the reply. | The project's holy grail — real tool execution instead of JSON emulation. |
| **H8.5** | **`RemoteMCPServer` runtime** in the plugin manifest points the agent at **our own MCP server**, exposing the coding agent's real tools (read_file/run_bash) as native Copilot actions. | Plugin manifest 2.4 added `type:"RemoteMCPServer"` (GA Apr 2026); inline `mcp_tool_description.tools[]` avoids package-file resolution. | Run a minimal Streamable-HTTP MCP server with one sentinel tool; embed inline; watch for an inbound `tools/call`. | Flips the architecture: *Copilot calls our tools* instead of us emulating them. |

> **H8.4/H8.5 caveat (H8-inline):** `actions[].file` and `mcp_tool_description.file`
> are *app-package-relative* — there's no package in the `minimalBots` flow.
> Always send the **inline** form (`api_description` string / inline `tools[]`).
> If file-based 400s but inline validates, that's the standard pattern.

### 8.2 — Model selection beyond `tone`

| # | Hypothesis | Why plausible | Probe | Payoff |
|---|---|---|---|---|
| **H8.6** | `tone` accepts a **Claude** value (`Claude_Sonnet`, `Anthropic_Claude`, …) and newer `Gpt_5_5_*`. | MS publicly shipped Claude in M365 Copilot; g365 already uses `Gpt_5_5_Reasoning`/`Gpt_5_5_Chat`. `tone` *is* the model selector. | Bisect tone candidates via `variants-bisect.mjs`; valid → content, invalid → error/silent `magic` fallback (detect via `contentOrigin`). | Route the coding agent to Claude through M365 at zero marginal cost. |
| **H8.7** | `capabilities:[{"name":"ScenarioModels","models":[{id}]}]` is a **back-door model binding** for `minimalBots` agents (which have no model field). | `ScenarioModels` is the only capability whose `models[].id` looks like a binding handle; full PVA bots expose `cuaAnthropicModels` (sonnet4-6/opus4-6). | Add it with a guessed id (`sonnet4-6`); even a rejection **error may leak the valid enum**. | Model binding from the declarative path — attacks the "no model knob" wall (quirk 14). |
| **H8.8** | Adding `SwitchRespondingEndpoint` to `allowedMessageTypes` reveals **mid-stream model routing** ("Auto"/Smart mode), and lets us detect when `magic` downgrades a coding task to the fast model. | kuchris/g365 whitelist it; MS "Smart Mode" docs describe real-time fast↔reasoning routing. | Add it; send a hard prompt at `tone:"magic"`; log whether the frame fires; compare to pinning `Gpt_5_4_Reasoning`. | Observability into which model answered + lever to force reasoning. |

### 8.3 — Grounding & multimodal

| # | Hypothesis | Why plausible | Probe | Payoff |
|---|---|---|---|---|
| **H8.9** | **Web search is a deterministic toggle:** `plugins:[]` + `optionsSets:["nosearchall"]` = off; our current `plugins:[{BingWebSearch}]` forces it on. | SydneyQt: `if NoSearch && len(Plugins)==0 { append("nosearchall") }`. Audit schema logs `AISystemPlugin:[{Id:"BingWebSearch"}]` only when search fired. | Same fresh-fact query with each config; watch `InternalSearchQuery`/`sourceAttributions` appear only when on; measure latency delta. | Off = faster, deterministic coding answers, no web derail. On (when wanted) = up-to-date docs + citations. |
| **H8.10** | **Image INPUT (vision)** works by POSTing the image to a substrate `UploadFile` endpoint (PyRIT: `/m365Copilot/UploadFile`; SydneyQt consumer analog: `bing.com/images/kblob`) → `docId`/`BlobId`, then attaching `messageAnnotations:[{id,messageAnnotationType:"ImageFile"}]` with `optionsSets:["cwcgptvsan",…]`. NOT via `entityAnnotationTypes`. | PyRIT implements the full enterprise flow incl. header `X-Variants:feature.EnableImageSupportInUploadFile`. | Replicate the upload POST with a screenshot, attach annotation, ask "what's in this image?"; confirm pixel-level vision. | Screenshots of errors, UI mockups, diagrams as agent input. |
| **H8.11** | **Graph/Work grounding** is gated by `entityAnnotationTypes` breadth + CIQ variants (`feature.EnableLuForChatCIQ`, `feature.enableChatCIQPlugin`) + `optionsSets:["at_mention_plugins_enable"]`; currently dormant because optionsSets is empty. | We already send the entity types; Zenity + audit schema confirm Graph entities (`TeamsChat`, mail, files) are grounding sources. | Enable CIQ variants, @-reference a real OneDrive file, watch for grounded citations. | M365 tenant data as a RAG backend — retrieval no other LLM API gives. |
| **H8.12** | **Long-document QA** is gated by `optionsSets:["ldqa","ldsummary"]` paired with a `File` entity; improves deep-in-doc recall and may route through the separate `numLongDocSummary…` counter (→ H8.18). | `ld*` flags in SydneyQt defaults; MS "summarization needs whole-doc context" docs. | Reference a long file, needle question, toggle `ldqa`/`ldsummary`. | Reliable long-context grounding (logs, specs, PDFs). |

### 8.4 — Memory, instructions, behavior (bears on the prose-compliance bug)

| # | Hypothesis | Why plausible | Probe | Payoff |
|---|---|---|---|---|
| **H8.13** | `behavior_overrides:{special_instructions:{discourage_model_knowledge:true}}` in the agent create payload makes the orchestrator **suppress base-model knowledge and prefer tools** — directly attacking "answers from memory instead of calling a tool." | Documented manifest-1.6 root field (structured, not free-text). `suggestions.disabled:true` is an even cheaper parse-canary. | Republish with the flag; ask a general-knowledge Q the model knows cold; if honored it defers to tools. | Structured tool-vs-memory control (the compliance lever we've only attacked with prompt wording). |
| **H8.14** | `optionsSets:["add_custom_instructions","update_memory_plugin","enable_inferred_memory_read"]` opens a **persistent instructions / memory channel** (a pseudo system-prompt that survives turns without re-sending). | kuchris exposes a `m365-copilot:persist` model built on exactly these. | Enable; turn 1 "remember code word sakura"; **new conversation**, ask for it; compare recall vs without. | Stateful agent persona/steering without burning context every turn. |
| **H8.15** | The `instructions` blob has a hard **8,000-char server ceiling** (other strings 4,000) and **silently truncates** rather than erroring — which could be corrupting our baked-in tool protocol. | Manifest 1.6 explicit limit; truncation-not-rejection is the classic silent break. | Publish agents with a sentinel at offsets 3.9k / 7.9k / 8.1k / 12k chars; ask it to echo each; highest recalled offset = the cap. | De-risks our core mechanism — know how much tool-protocol fits before silent truncation. |
| **H8.16** | `worker_agents:[{id:"<TitleId>"}]` lets one published agent **delegate to another** (multi-agent over BizChat) addressable through one `threadLevelGptId`. | New manifest-1.6 field; `id` = the TitleId we already publish against. | Publish agent B (sentinel); create A with `worker_agents:[{id:B}]`; ask A something only B does. | Router + specialized-tool-agent composition (e.g. a CodeInterpreter worker behind a router). |

### 8.5 — Quota / throttling / licensing

| # | Hypothesis | Why plausible | Probe | Payoff |
|---|---|---|---|---|
| **H8.17** | `licenseType:"Starter"` (we hardcode it) is an **internal priority-tier enum**, not a SKU; a Premium/Enterprise value buys priority-access headroom and fewer empty-reply throttles. | "Starter" isn't a customer SKU; MS docs: standard users "temporarily restricted to support priority access of premium users" — matches our self-recovering empties. | Enumerate `licenseType` values in the WS query; A/B time-to-first-empty under a fixed burst. | Directly attacks the account-level throttling. |
| **H8.18** | The **600-cap is purely per-`conversationId`**; rotating the conversation (or chaining `conversationTransferToken`) **resets the counter to 0** with no daily/account aggregate. | No per-day chat cap is published for licensed users; counter is named "…InConversation"; transfer token implies supported state migration. | Drive one conv to ~590; rotate id → confirm reset; test whether `conversationTransferToken` carries context *without* the counter. | Sidestep the 600-cap entirely (extends F8). |
| **H8.19** | `numLongDocSummaryUserMessagesInConversation` is a **separate, smaller sub-cap** with its own `max…` field for heavy whole-doc-context turns. | Separate counter only makes sense with its own ceiling; MS treats summarization as a distinct heavy path. | Send large-context turns; watch which counter increments; binary-search the size that flips a turn to "longDocSummary"; look for a 2nd `max…` in the same frame. | Keep heavy turns from burning the scarce summary budget; learn the context threshold. |
| **H8.20** | The empty-reply throttle is **RPM-based with a fixed cooldown** (Studio publishes a "100 RPM — M365 Copilot users" quota the substrate may share). | Symptom (burst→empty→self-recover) matches RPM throttling. | Sweep fixed rates (10/30/60/100/120 RPM); record onset + cooldown; check for a Retry-After-like field. | A client-side rate-limiter config that *prevents* throttling vs reacting to it. |
| **H8.21** | `&disableMemory=1` on the **WS URL** gives stateless "temporary chat" (no history; possibly different cap/Disengaged behavior). | edlaver bun-proxy README documents exactly this URL flag. | Append it; confirm no history; A/B the 600-cap and Disengaged sensitivity. | Privacy + a possible per-conversation-cap sidestep. |
| **H8.22** | **Purview audit (`CopilotInteraction`, RecordType 261) is a model side-channel:** its `ModelTransparencyDetails.ModelName` reveals which real model served each turn (join on `ThreadId`=conversationId), and whether throttling **downgrades the model** vs dropping the turn. The Graph `getMicrosoft365CopilotUsageUserDetail` report is a usage oracle. | Audit schema carries `ModelName`/`ThreadId`/`Messages[].Size`; the WS frames hide model identity behind `tone`. | After a burst, GET Purview audit, join on ThreadId, diff `ModelName` throttled vs not. | Model-identity + usage telemetry the WS won't give us. |

> **H8-guardrail (don't chase a ghost):** licensed first-party BizChat is **USL
> flat-rate, not message-metered** — there is **no token/cost field to find** on
> our path (resolves F5's hunt as *correctly empty*, not just unfound). Per-message
> cost/credit telemetry only exists when invoking a *custom Copilot Studio agent*
> under a non-licensed identity (Copilot Credits: 1/classic, 2/generative, 5/action,
> 10/graph-grounding). If we ever want cost accounting, that's the surface — not BizChat.

### 8.6 — Prioritized test order (cheap oracle → high payoff)

1. **H8.9 (search toggle)** — one-line change, immediate latency/quality win, zero risk.
2. **H8.3 (GraphicArt) / H8.13 `suggestions.disabled`** — cheap *capability-acceptance canaries*: prove the `capabilities`/`behavior_overrides` arrays are honored at all before investing in actions.
3. **H8.1 (code interpreter via optionsSets)** — biggest new capability, testable with `variants-bisect.mjs`, no agent rebuild.
4. **H8.13 + H8.14 (behavior_overrides + memory)** — directly target the prose-compliance bug.
5. **H8.6 (Claude tone)** — cheap bisect, possibly a stronger coding model.
6. **H8.17 + H8.20 (licenseType + RPM)** — attack throttling.
7. **H8.18 (conversation rotation)** — nullify the 600-cap.
8. **H8.4 → H8-inline → H8.5 (native actions / MCP)** — the holy grail; always inline form.

### 8.7 — New probes these motivate

| Probe | Tests | Cost |
|---|---|---|
| `optionsets-sweep.mjs` | Add wild `optionsSets`/`allowedMessageTypes` (§8.8) and diff new frame types (`GeneratedCode`, image, `SwitchRespondingEndpoint`). | ~5 msgs |
| `search-toggle.mjs` | H8.9 — `plugins:[]`+`nosearchall` vs default; latency + `InternalSearchQuery`. | ~4 msgs |
| `tone-claude-bisect.mjs` | H8.6 — bisect Claude/`Gpt_5_5_*` tone strings. | ~8 msgs |
| `capability-canary.mjs` | H8.3/H8.13 — does `capabilities[]`/`behavior_overrides` in `minimalBots` create get honored? | ~2 msgs + 1 agent build |
| `code-interpreter-probe.mjs` | H8.1/H8.2 — Python sandbox via optionsSets and via capability. | ~4 msgs |
| `image-input-probe.mjs` | H8.10 — UploadFile → annotation → vision. | ~3 msgs |
| `conversation-rotation.mjs` | H8.18 — does a fresh conv / transfer token reset the 600 counter? | ~6 msgs |
| `licensetype-throttle.mjs` | H8.17/H8.20 — license enum + RPM sweep vs empty-reply onset. | bursty |

### 8.8 — Reference implementations to mine (the real payloads)

Live code hitting **this exact endpoint** — copy their `optionsSets`/`variants`/
`allowedMessageTypes` verbatim and diff against ours (which sends `optionsSets:[]`).

| Source | What it gives | URL |
|---|---|---|
| **microsoft/PyRIT** (`websocket_copilot_target.py`) | MS's own harness: concrete optionsSets, **image upload via `/m365Copilot/UploadFile`**, `messageAnnotations`. | https://github.com/microsoft/PyRIT |
| **kuchris/m365-copilot-openai-proxy** (`substrate_client.py`) | Richest `_VARIANTS`/`_OPTIONS_SETS`/`_ALLOWED_MESSAGE_TYPES` in the wild; a `persist` model on memory flags. | https://github.com/kuchris/m365-copilot-openai-proxy |
| **notBlubbll/g365-headless-relay** (`lib/bridge.js`) | Current `tone` map (`Gpt_5_5_*`), full optionsSets, `SwitchRespondingEndpoint`. | https://github.com/notBlubbll/g365-headless-relay |
| **edlaver/m365-copilot-bun-proxy** (`config.json`) | `disableMemory=1` temporary-chat URL flag; `enterprise_flux_*` optionsSets. | https://github.com/edlaver/m365-copilot-bun-proxy |
| **juzeon/SydneyQt** (`sydney/sydney.go`,`upload.go`) | Consumer-Bing lineage: default optionsSets (`codeintfile`,`sdretrieval`,`ldqa`,`gptv*`), `nosearchall` logic, `kblob` image upload. | https://github.com/juzeon/SydneyQt |
| **Zenity Labs** writeup | Live enterprise `arguments[0]` shape (`allowedMessageTypes`, `entityAnnotationTypes`). | https://labs.zenity.io/p/access-copilot-m365-terminal |
| **Copilot interaction audit schema** (official) | Ground-truth per-turn fields: `AISystemPlugin`, `ModelTransparencyDetails.ModelName`, `Messages[].Size`. | https://learn.microsoft.com/en-us/office/office-365-management-api/copilot-schema |
| **Declarative agent manifest 1.6/1.7 + plugin manifest 2.4** | Capability enum (`CodeInterpreter`,`WebSearch`,`GraphicArt`,`ScenarioModels`,…), `actions`, `RemoteMCPServer`, `behavior_overrides`, `worker_agents`, instruction limits. | https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/declarative-agent-manifest-1.6 · /plugin-manifest-2.4 |

> ⚠️ **Endpoint caveat:** PyRIT/kuchris/g365/edlaver hit **enterprise BizChat**
> (`substrate.office.com/m365Copilot/Chathub`, our exact target). SydneyQt/sydney.py
> hit **consumer Bing** (`bing.com`) — same Sydney lineage, field names transfer,
> but image-upload host and some optionsSet availability may need the office.com
> equivalent. Highest-confidence enterprise signals: PyRIT + the official audit schema.

### 8.9 — CONFIRMED live (June 13 2026 dig), service `1.0.03449.35222`

Probed against the live API. **Two headline wins shipped.**

**✅ H8.1 — Code interpreter is real (`cwc_code_interpreter` optionsSets) 🟢.**
With `optionsSets:["cwc_code_interpreter","cwc_code_interpreter_amsfix",
"cwc_code_interpreter_citation_fix","code_interpreter_interactive_charts",
"code_interpreter_matplotlib_patching"]` + `allowedMessageTypes:["GeneratedCode",
"GenerateContentQuery","Progress"]`, a SHA-256 oracle proved **real server-side
Python execution**: asked for `sha256("m365-codeinterp-probe-<ts>")`, M365 emitted
a `GeneratedCode` frame running `hashlib.sha256(...).hexdigest()` and returned the
**correct** digest (impossible to fake from memory). n=1, plain chat (no agent),
`contentOrigin:DeepLeo`, 8.7s. Probe: `scripts/code-interpreter-probe.mjs`.
*Not yet wired into the proxy* — it's a free server-side tool (hashing, math,
data transforms) we can expose. Caveat: it's M365's sandbox, not the harness's.

**✅ H8.6 — Claude Sonnet 4.5 is reachable via `tone` 🟢 (SHIPPED).**
The server **validates tones** (bogus `Definitely_Not_A_Real_Tone` and
`Anthropic_Claude`/`Claude_Haiku`/`Gpt_5_6_Chat` all error with "Failed to invoke
'Chat'"), so an accepted tone is a real route. Confirmed accepted + self-identified:

| tone | model id | self-report | notes |
|---|---|---|---|
| `Claude_Sonnet` | `claude` / `claude-sonnet` | **"Claude Sonnet 4.5, by Anthropic"** (5/5 runs) | real Claude |
| `Claude_Sonnet_Reasoning` | `claude-sonnet-think-deeper` | "Claude Sonnet 4.5, by Anthropic" | real Claude + reasoning |
| `Claude_Opus` | `claude-opus` | (deflected) | accepted tone; likely Opus |
| `Gpt_5_5_Chat` / `Gpt_5_5_Reasoning` | `gpt-5.5*` | GPT-5 | current GPT gen |
| `Claude_Reasoning` | — | GPT-5 | accepted but NOT Claude (don't use) |

**Mechanism — the agent overrides the tone 🟢.** `NO agent + Claude_Sonnet →
Claude`; `WITH agent (threadLevelGptId) + Claude_Sonnet → GPT-5`. The declarative
tool agent forces GPT-5 routing, and a heavy tool prompt under a Claude tone +
agent **Disengages persistently**. Ruled out as causes: prompt wrapper, the
40-flag `variants` list, conversation reuse — isolated cleanly to agent presence.
→ **Consequence:** Claude is usable for **plain chat** but NOT for tools via our
emulation agent. Getting Claude+tools needs the native-action/MCP path (H8.4/H8.5,
no declarative agent).

**Shipped from this dig:** `claude*`/`gpt-5.5*` model ids; agent attached **only**
for tool requests (so `claude-sonnet` plain chat reaches real Claude through the
proxy — verified); `Disengaged` now fails fast instead of burning 5 quota messages
on "Please continue." retries.

**Probes added:** `code-interpreter-probe.mjs`, `tone-probe.mjs`; `_probe-chat.mjs`
gained `optionsSets` / `extraAllowed` / `plugins` / `variants` overrides.

**Also shipped:** code interpreter is now wired into the proxy on the agent-less
(plain-chat) path — `CODE_INTERPRETER_OPTIONS_SETS` in `session.ts`, on by
default, disable with `M365_NO_CODE_INTERPRETER=1`. Verified end-to-end through
the proxy (SHA-256 oracle). Left off the agent/tool path so it doesn't compete
with tool-JSON emission.

**MCP / native-action foothold (H8.4/H8.5) — infra ready, schema RE pending.**
A cloudflared **quick tunnel needs no account** (`cloudflared tunnel --url
http://localhost:PORT` → a `*.trycloudflare.com` URL) — confirmed working, reaching
a local sentinel server (`scripts/sentinel-server.mjs`, serves an OpenAPI spec at
`/openapi.json`, a `/sentinel` endpoint, and a minimal MCP endpoint at `/mcp`; it
logs every inbound hit so we can see if Copilot's orchestrator calls us). The
remaining unknown is the **`minimalBots` create-payload schema for actions**: the
insertion points are `aIPluginOperationChanges` (top level) and `metadata.tools`
(GPT component) in `agent.ts::createBot`, both currently `[]` — these are
undocumented Dataverse `aiplugin`/`aipluginoperation` shapes. Next session: POST
create attempts and read the 400s to infer the schema (PowerPlatform API, doesn't
burn BizChat quota), then chat-test whether Copilot calls the tunnel. Cheaper
adjacent win first: `gptCapabilities.{codeInterpreter,webBrowsing}:true` in
`createBot` are *documented* toggles already in our payload (set `false`) — flip
to give the tool **agent** native code-exec / web search.

**Open / next:** populate `optionsSets` on the main path (memory,
custom-instructions, image) once verified not to break the agent route; the
Disengaged tool-count calibration for Hermes-sized toolsets.

### 8.10 — MCP / native tools: the architecture wall (June 13, conclusive)

Pushed the native-action/MCP path (H8.4/H8.5) to its wall. **Infra works**
(cloudflared quick tunnel, no account → local MCP server, `tools/list` over the
public URL returns our tool). The blocker is *where our agent lives*:

1. **Old `minimalBots` API (`2022-03-01-preview`, what `agent.ts` uses) predates
   MCP.** It accepts a tool `DialogComponent` structurally but rejects every tool
   dialog (`kind: McpTool` bare `serverUrl`; `TaskDialog`) with
   `500 — out of range (Parameter 'Dialog')`. `scripts/mcp-agent-probe.mjs`.

2. **The modern tool API is the Island Gateway**
   (`powervamg.{geo}-il{island}.gateway.prod.island.powerapps.com`, ours is
   `eu-il105`), `PUT /api/botmanagement/v1/environments/{env}/bots/{bot}/content/botcomponents`.
   Discovered host + auth by capturing the real Copilot Studio frontend
   (`scripts/gateway-capture.mjs`). **Auth:** token `aud`/`appid` =
   `96ff4394-9197-43aa-b393-6a41652e21f8` (the Copilot Studio SPA's *own* app id),
   not our `c0ab8ce9` Office-web client — so clean acquisition needs a separate
   MSAL flow for that client (likely a one-time interactive consent). For probing
   we borrow a live token from the authenticated browser session
   (`scripts/gateway-explore.mjs`).

3. **The wall (decisive):** our agent is a **lightweight bot**. The gateway
   *routes* to it (`botroutinginfo → 200`, `isLightWeightBot:true`) so BizChat can
   reach it — but it has **no Dataverse component storage**:
   `content/botcomponents → 404 "Entity 'bot' ... Does Not Exist" /
   StorageUnitNotAssigned`, and the full-bot list is `[]`. **MCP tools/connectors
   live in `botcomponents`, which only full Dataverse bots have.** So MCP cannot
   attach to the lightweight agents BizChat actually uses.

**The fork (needs a decision / the user):**
- **(A) Full Dataverse bot.** Create a full Copilot Studio bot via the gateway,
  add the MCP tool component, publish — then test the **unverified** question:
  *does a full Dataverse/PVA bot plug into the BizChat WS at all?* (Our docs §10
  flagged this ❓.) If yes → MCP works; if no → MCP-over-BizChat is impossible.
  This is the decisive next experiment.
- **(B) M365 declarative-agent app package.** The *other* tool mechanism: package
  the agent as a Teams/M365 app (`declarative-agent.json` + `ai-plugin.json` with a
  `RemoteMCPServer` runtime, api-plugin manifest 2.4) and deploy via the app
  catalog. Different pipeline entirely; BizChat-reachability of its actions also
  unverified.

**Security note (re: public tunnel = RCE):** a real MCP server exposing harness
tools (bash, write_file) over a public tunnel is an open RCE without auth. Both
the connector route and the manifest route support `auth: ApiKey` / `securityDefinitions`
— wire an API key (or OAuth) before exposing anything executable. `sentinel-server.mjs`
is harmless (read-only sentinel) and fine to leave anonymous for probing only.

**Probes added:** `mcp-agent-probe.mjs`, `gateway-capture.mjs`, `gateway-explore.mjs`,
`sentinel-server.mjs`.

### 8.12 — Benchmark baseline: tool-call compliance is ~0 on realistic tasks 🟢

The `scripts/bench/` harness (validated against a mock — it scores SOLVED when a
real tool call arrives) run against the default proxy:

| config | result | outcomes |
|---|---|---|
| baseline (magic, 4 tools) | **0/5** | 3 GAVE_UP_PROSE, 2 disengage |
| bash-only (lean payload) | **0/3** | 2 prose, 1 disengage |
| few-shot ON (`M365_KEEP_FEWSHOT=1`) | **0/3** | 2 prose, 1 disengage |

**Zero tool calls across all three.** The raw model output (trace) is pure prose —
e.g. *"Created fizzbuzz.py and executed it with python3."* with `hasToolCalls=false`
— the magic/DeepLeo model **claims completion without emitting any tool JSON**,
flatly violating its injected "never claim done without a tool_response" rule.

**Disproved levers:** tool count (H5) and few-shot (H2) — neither moves it. So the
0-compliance is **not** a tuning problem; it's the model being a chat-assistant
that answers rather than an agent that acts, on familiar coding tasks.

**Outcome pattern:** *fakeable* tasks (fizzbuzz, count-lines) → hallucinate success;
*unfakeable* tasks (edit-config, find-needle — need to read real files) → Disengage.
Either way, no tool call.

**Discrepancy to explain:** the June-9 `tool-compliance-experiment.mjs` scored
~3/3 "compliant" with crafted single-turn prompts (§F2–F4), yet realistic
multi-turn agentic tasks score 0. Compliance is evidently prompt-shape-sensitive;
the crafted-prompt number did not generalise to real agent loops.

**Caveat:** measured while the account was heavily used (disengaging on every
`edit-config` run) — re-baseline on a fresh account/day before treating the exact
counts as load-bearing. The *prose-hallucination* failure is model behaviour, not
throttle, and reproduced every run.

**Next (needs code, run on a fresh account):** H4 — the fenced ` ```bash `/` ```edit `
format vs JSON, head-to-head on the bench. Config levers are exhausted; format/prompt
redesign is the remaining lever.

**H4 — fenced tool format: 🟡 BUILT, awaiting live A/B (this session).** Implemented
`M365_TOOL_FORMAT=fenced` end-to-end — the model emits ` ```toolname ` code fences
(scalar args as `key: value` headers, one free-form body arg as the fence body,
`old`/`new` edits as `SEARCH/REPLACE` diffs) instead of `{"tool":...}` JSON. Rationale:
the 0/5 baseline is the chat-tuned model narrating success instead of acting, and the
JSON-string escaping burden for multi-line `write_file`/`edit_file` bodies is a prime
suspect — fenced code is training-natural and needs no escaping. Both the per-request
`<tools>` block AND the server-side agent prompt have fenced variants (so the flag
auto-provisions a fresh agent by instructions hash). JSON remains default + fallback.
Code: `packages/core/src/fenced.ts`, wired via `tools.ts`/`agent.ts`; unit-tested
(`fenced.test.ts`, `tools.test.ts`). **Falsification:** run E-C1 on a rested account —
if SOLVED(fenced) ≤ SOLVED(json) across `--repeat 2`, H4 is dead and the prose-narration
failure is format-independent (→ pivot to E-C3 anti-hallucination framing / E-C2
task-type targeting). Prediction: fenced helps most on `write_file`/`edit_file` tasks.

---

### 8.11 — Both native-tool paths CLOSED on this tenant (June 13, conclusive)

Ran both forks to a definitive end. **Both are blocked**, for independent reasons.

**Fork A — full Dataverse bot: blocked by tenant licensing.** Driving the real
Copilot Studio UI (`scripts/create-full-bot.mjs`) lands on a *"Select a team — to
create agents for Microsoft Teams"* gate plus *"Try the full capabilities of
Copilot Studio by upgrading your license / start a trial."* This tenant has only
the **lightweight "Copilot Studio for Teams"** tier — which is exactly why every
agent we create is a storage-less lightweight bot (§8.10). Creating a
**full Dataverse bot** (the only kind that can hold MCP/connector tools) requires
a **Copilot Studio license or trial** the tenant lacks. Not startable without an
explicit billing decision. *If* the trial is started, the rest is ready: gateway
host (`eu-il105`), the SPA token (`96ff4394`), and the `content/botcomponents` PUT
with a `kind: McpTool` DialogComponent (from Microsoft's own `island-client.js`).

**Fork B — code-interpreter Python → our endpoint: blocked by a hard airgap.**
The user's idea: the code interpreter runs real Python, so have it `requests.get`
our tunnel. Tested rigorously (5 msgs, every one confirmed by a `GeneratedCode`
frame = real execution; ground truth = `sentinel-hits.log`, which recorded **zero**
sandbox hits). The sandbox is **fully network-isolated, below Python**:
- **DNS dead** — `/etc/resolv.conf` is empty; `socket.gethostbyname` →
  `gaierror(-3, Temporary failure in name resolution)`.
- **The `http_proxy` (`localhost:8000`) is a trap** — a Go stub that returns
  `404` to CONNECT for *every* host (incl. microsoft.com); it forwards nothing.
- **Raw TCP to public IPs** (`1.1.1.1:443`, `8.8.8.8:53`, Google) → `TimeoutError`
  (silently dropped — no route out of the netns).
- Only `localhost` services reachable (an internal Jetty on `:9998`).
No library/technique workaround exists — the block is at the network namespace.
Probes: `code-interp-egress.mjs` (+ subagent's `code-interp-{egress-diag,proxy-probe,rawip-probe,rawip2}.mjs`).

**Conclusion.** The lightweight, BizChat-reachable agent **cannot be given real
tools** on this tenant: it has no tool storage (§8.10), and its sandbox can't
reach out (Fork B). Native tool-calling over BizChat would require **Fork A**,
which is gated on a Copilot Studio license/trial.

**Decision (project scope): Fork A is OUT OF SCOPE — do not pursue it.** The entire
point of this project is turning a **free student M365 or an existing corporate
seat into something useful at ZERO added cost**. A Copilot Studio license/trial
defeats that premise — the target users (students, corp employees without admin
license budget) don't have it and won't buy it. So the native-MCP/full-bot path is
permanently parked *by design*, not pending a trial. **Tool calling stays
prompt-emulated** — the declarative lightweight agent + the model emitting
` {"tool":...,"arguments":...} ` JSON that the proxy parses (`tools.ts`/`handler.ts`).
Future sessions: don't re-investigate MCP, full Dataverse bots, the Island Gateway
tool API, or trials — they all require licensing the user base lacks. Improve the
prompt-emulated path instead (compliance, the §8 optionsSets capabilities that
need no license: code interpreter, memory, web grounding, image).

The genuine, zero-cost wins this session — code interpreter (compute, not egress),
Claude for plain chat, GPT-5.5, the I/O + cancel work — stand on their own and are
exactly the right kind of improvement: capability with no license attached.
