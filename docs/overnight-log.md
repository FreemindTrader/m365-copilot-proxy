# Overnight work log (autonomous session, started 2026-06-24 night)

Durable scratch log so work survives context summarization. Newest entries at top.
Goal: usable coding agent in pi/openclaw via the prompt-emulated shell-routing path.

## Operating constraints (self-reminders)
- SEQUENTIAL only. One M365 thread at a time. Long cooldowns between thread-heavy runs.
- Offline work (code, tests, analysis, docs) = no quota → run freely.
- Live work (bench/pi/probes) = burns quota + thread-rate throttle → space with ~1h cooldowns (ScheduleWakeup).
- Every Bash call has an explicit timeout. Long waits via ScheduleWakeup, not foreground sleep.
- n=1 is noise. Confirm winners with --repeat, rotate order.
- Native tool-calling is OUT OF SCOPE (licensing). Improve prompt-emulated path only.

## Plan / phases
- [x] P0 recon code (handler detectors, fenced strategies, bench harness)
- [x] P1 OFFLINE: fakeable-task hallucination detector broadened + unit tests → commit fc92498
      (catches §8.12 "Created fizzbuzz.py and executed it with python3."; FP-guarded; gated on !everActed)
- [ ] P2 OFFLINE: verify A/B framing sweep is runnable (mock proxy), prep configs
- [ ] P3 LIVE (spaced): auth smoke → framing A/B sweep → ~10x pi fix-bug → validate F16
- [ ] P4 analyze + write up findings into hypotheses.md, graduate conclusive ones

## Notes
- count-style pure-result hallucinations ("the file has 42 lines") deliberately
  NOT matched — too FP-risky vs real answers. §9 says fakeable tasks also need
  task-redesign; the create+execute pattern is the clean proxy-side win.

## LIVE STATE (read this first on wake-up)
A throttle-aware overnight framing A/B sweep is RUNNING in the background.
- **Orchestrator:** `scripts/bench/overnight-sweep.sh` (committed dbd94b7).
- **Grid:** 10 framing strategies × 3 unfakeable tasks (fix-bug, find-needle, edit-config),
  ROUNDS=30, CELL_COOLDOWN=120s, rotated order per round. ~90 min/round → expect ~5-6 rounds/night.
- **Results CSV (append-only):** `/tmp/m365-overnight.csv` (round,ts,task,strategy,outcome,tools,msgs,elapsed_s)
- **Per-cell JSON:** `scripts/bench/out/ov-<round>-<task>-<strategy>-<ts>.json`
- **Run log:** `/tmp/m365-overnight.run.log` ; **heartbeat:** `/tmp/m365-overnight.heartbeat`
- **Proxy:** persistent, port 4141, started in `nix develop` with
  `M365_FRAMING_FILE=/tmp/m365-framing M365_DEBUG=1`. Auth = silent-refresh (worked off the
  2-week-old msal-cache). Proxy log: `/tmp/m365-proxy.log`.

### On wake-up, do:
1. `curl -s -m3 http://localhost:4141/health` — if DOWN, restart proxy:
   `nix develop --command bash -c 'M365_DEBUG=1 M365_FRAMING_FILE=/tmp/m365-framing node packages/proxy/bin/m365-proxy.mjs 4141' &` (background), wait for "Listening".
2. Check the background sweep task is still alive; if it died, relaunch overnight-sweep.sh
   (it appends to the same CSV — resumable).
3. Tally CSV: `tail -n+2 /tmp/m365-overnight.csv | awk -F, '{c[$5]++}END{for(o in c)print o,c[o]}'`.
   Many ERROR/PROXY_DOWN in a row = throttle or dead proxy → fix, then let it ride.
4. Once ≥3 rounds done (~n≥3/cell), analyze SOLVED-rate by strategy:
   `tail -n+2 /tmp/m365-overnight.csv | awk -F, '{t[$4]++; if($5=="SOLVED")s[$4]++}END{for(k in t)printf "%-12s %d/%d\n",k,s[k],t[k]}' | sort`
   and write a finding into hypotheses.md §8.12/§9 (graduate if conclusive). Control for order/throttle.
5. Reschedule the next wake-up (~30 min) unless the night's clearly over / data's conclusive.

### Smoke results (baseline, pre-sweep), rested account:
- fix-bug SOLVED 2 tools/3 msgs/51s. Validation r1: fix-bug SOLVED under minimal/terse/baseline (3/3).

## Timeline / entries
- 2026-06-25 00:09 — wake 1. Proxy UP, sweep alive (heartbeat <1min). Round 1 at 12/30 cells.
  Tally: SOLVED 9, ERROR 2, GAVE_UP_PROSE 1. Pace ~2.8 min/cell → ~85min/round.
  **Early signal (n=1 each, WATCH don't conclude):** both ERRORs were **Disengaged**
  (content filter, confirmed in per-cell JSON), and both were the aggressively-shaped
  framings — `persona` (fix-bug) and `recency` (find-needle). Matches F10 (Disengaged =
  jailbreak *shape*, not size). Hypothesis to confirm across rounds: aggressive framings
  (persona/recency, maybe negative/terse) Disengage more than lean ones (minimal/baseline),
  forfeiting the whole task. The 1 GAVE_UP_PROSE: need to check which strategy.
- 2026-06-24 night: session start. Env confirmed (clean tree, creds present, nix OK, bench present).
  msal-cache.json dated Jun 9 — expect silent-refresh or reauth on first live call.
