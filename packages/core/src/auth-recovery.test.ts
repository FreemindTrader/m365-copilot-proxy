import { describe, it, expect, vi } from "vitest";
import { createReauthTracker } from "./auth-recovery.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(overrides: Record<string, unknown> = {}) {
  let t = 0;
  const reauth = vi.fn(async () => true);
  const tracker = createReauthTracker({
    reauth,
    now: () => t,
    windowMs: 1000,
    threshold: 3,
    cooldownMs: 5000,
    ...overrides,
  });
  return { tracker, reauth, advance: (ms: number) => { t += ms; } };
}

describe("createReauthTracker", () => {
  it("does not trigger below the distinct-conversation threshold", async () => {
    const { tracker, reauth } = setup();
    tracker.note(true, "c1");
    tracker.note(true, "c2");
    await flush();
    expect(reauth).not.toHaveBeenCalled();
  });

  it("triggers once enough DISTINCT conversations go empty within the window", async () => {
    const { tracker, reauth } = setup();
    tracker.note(true, "c1");
    tracker.note(true, "c2");
    tracker.note(true, "c3");
    await flush();
    expect(reauth).toHaveBeenCalledTimes(1);
  });

  it("does NOT count repeated empties in the SAME conversation", async () => {
    const { tracker, reauth } = setup();
    tracker.note(true, "c1");
    tracker.note(true, "c1");
    tracker.note(true, "c1");
    await flush();
    expect(reauth).not.toHaveBeenCalled();
  });

  it("a clean response resets the streak", async () => {
    const { tracker, reauth } = setup();
    tracker.note(true, "c1");
    tracker.note(true, "c2");
    tracker.note(false, "c2"); // recovered
    tracker.note(true, "c3");
    await flush();
    expect(reauth).not.toHaveBeenCalled();
  });

  it("honors the cooldown between triggers", async () => {
    const { tracker, reauth, advance } = setup();
    tracker.note(true, "a1");
    tracker.note(true, "a2");
    tracker.note(true, "a3");
    await flush();
    expect(reauth).toHaveBeenCalledTimes(1);

    // within cooldown — even a fresh batch must not re-trigger
    advance(1000);
    tracker.note(true, "b1");
    tracker.note(true, "b2");
    tracker.note(true, "b3");
    await flush();
    expect(reauth).toHaveBeenCalledTimes(1);

    // past cooldown — triggers again
    advance(5000);
    tracker.note(true, "d1");
    tracker.note(true, "d2");
    tracker.note(true, "d3");
    await flush();
    expect(reauth).toHaveBeenCalledTimes(2);
  });

  it("drops empties that fall outside the window", async () => {
    const { tracker, reauth, advance } = setup();
    tracker.note(true, "c1");
    advance(2000); // > windowMs (1000) → c1 expires
    tracker.note(true, "c2");
    tracker.note(true, "c3");
    await flush();
    expect(reauth).not.toHaveBeenCalled(); // only 2 in-window
  });
});
