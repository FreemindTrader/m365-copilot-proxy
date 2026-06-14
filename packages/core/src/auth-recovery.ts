import { forceReauth } from "./auth.js";
import { createLogger } from "./log.js";

const log = createLogger("reauth");

// Auto-reauth policy (docs/hypotheses.md §9 F13). Account degradation is thread-rate
// throttling that surfaces as EMPTY responses across many conversations; a fresh
// login clears it. We trigger a background re-login when empties pile up across
// DISTINCT conversations within a window — distinct-conversation is the key signal:
// repeated empties in ONE conversation are usually content-specific (a bad agent,
// a Disengage-shaped prompt), not account throttle, and re-login won't help those.
//
// Guards against login storms: single-flight (the reauth itself), a cooldown between
// triggers, and a clean-success resets the streak. The trigger never blocks the
// request path — the current request still returns its empty; subsequent ones recover.

export interface ReauthTrackerOptions {
  /** The re-login action. Returns true on success. */
  reauth: () => Promise<boolean>;
  /** Clock injection for tests. Defaults to Date.now. */
  now?: () => number;
  /** Empties older than this fall out of the window. */
  windowMs?: number;
  /** Distinct-conversation empties within the window needed to trigger. */
  threshold?: number;
  /** Minimum time between triggers, even if the threshold keeps being met. */
  cooldownMs?: number;
  /** Called when a trigger fires (for logging/telemetry). */
  onTrigger?: (info: { distinctConversations: number }) => void;
}

export interface ReauthTracker {
  /** Record one request outcome. `empty` = throttle-shaped empty response. */
  note: (empty: boolean, conversationId: string) => void;
}

export function createReauthTracker(opts: ReauthTrackerOptions): ReauthTracker {
  const now = opts.now ?? (() => Date.now());
  const windowMs = opts.windowMs ?? 120_000;
  const threshold = opts.threshold ?? 3;
  const cooldownMs = opts.cooldownMs ?? 300_000;

  let empties: Array<{ t: number; conv: string }> = [];
  let lastTriggerAt = -Infinity;
  let reauthing = false;

  return {
    note(empty, conversationId) {
      const t = now();
      if (!empty) {
        // A clean response means degradation has lifted — reset the streak.
        empties = [];
        return;
      }

      empties.push({ t, conv: conversationId || `anon-${t}` });
      empties = empties.filter((e) => t - e.t < windowMs);

      const distinct = new Set(empties.map((e) => e.conv)).size;
      if (distinct < threshold) return;
      if (reauthing || t - lastTriggerAt < cooldownMs) return;

      reauthing = true;
      lastTriggerAt = t;
      empties = [];
      opts.onTrigger?.({ distinctConversations: distinct });

      Promise.resolve()
        .then(() => opts.reauth())
        .then(
          (ok) => log.info(`Auto-reauth ${ok ? "succeeded" : "failed"}`),
          (err) => log.error(`Auto-reauth threw: ${err?.message ?? err}`),
        )
        .finally(() => { reauthing = false; });
    },
  };
}

const defaultTracker = createReauthTracker({
  reauth: forceReauth,
  windowMs: Number(process.env.M365_REAUTH_WINDOW_MS ?? 120_000),
  threshold: Number(process.env.M365_REAUTH_EMPTY_THRESHOLD ?? 3),
  cooldownMs: Number(process.env.M365_REAUTH_COOLDOWN_MS ?? 300_000),
  onTrigger: ({ distinctConversations }) =>
    log.info(
      `Auto-reauth: ${distinctConversations} empty responses across distinct conversations — forcing fresh login to clear throttle (F13). Disable with M365_NO_AUTO_REAUTH=1.`,
    ),
});

/** Record a request outcome for the global auto-reauth policy. No-op if disabled. */
export function noteRequestOutcome(empty: boolean, conversationId: string): void {
  if (process.env.M365_NO_AUTO_REAUTH) return;
  defaultTracker.note(empty, conversationId);
}
