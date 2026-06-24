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

## Timeline / entries
- 2026-06-24 night: session start. Env confirmed (clean tree, creds present, nix OK, bench present).
  msal-cache.json dated Jun 9 — expect silent-refresh or reauth on first live call.
