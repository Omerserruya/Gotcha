import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `effectivePresence` is the one rule that decides what a human is shown, and
 * every surface that reads presence goes through it. What it defends:
 *
 *   - presence never CLAIMS availability it cannot support. A row saying BUSY
 *     or ONLINE that stopped heartbeating is a closed laptop, and reporting it
 *     as anything but OFFLINE is the exact lie the feature exists to prevent.
 *   - a stated away window ENDS. An agent who set "away until 11:00" and is
 *     still working at 15:00 reads as ONLINE, with no job required to say so.
 *   - `awayUntil` is only ever returned with AWAY, so no client can render
 *     "away until 11:00" beside a green dot.
 */
const { prismaMock } = vi.hoisted(() => ({
  prismaMock: { agentPresence: { upsert: vi.fn() } },
}));
vi.mock("../prisma", () => ({ prisma: prismaMock }));

import { effectivePresence, declarePresence, PRESENCE_STALE_AFTER_MS } from "../agent-presence";

const NOW = new Date("2026-09-07T10:00:00.000Z");
const fresh = new Date(NOW.getTime() - 30 * 1000);
const stale = new Date(NOW.getTime() - PRESENCE_STALE_AFTER_MS - 1000);

describe("effectivePresence", () => {
  it("reports a live ONLINE agent as ONLINE", () => {
    expect(effectivePresence({ status: "ONLINE", lastSeenAt: fresh }, NOW)).toEqual({
      status: "ONLINE",
      awayUntil: null,
    });
  });

  it("reports a live BUSY agent as BUSY", () => {
    expect(effectivePresence({ status: "BUSY", lastSeenAt: fresh }, NOW).status).toBe("BUSY");
  });

  // The important one: staleness OVERRIDES whatever the row says.
  it("reports a stale ONLINE row as OFFLINE", () => {
    expect(effectivePresence({ status: "ONLINE", lastSeenAt: stale }, NOW).status).toBe("OFFLINE");
  });

  it("reports a stale BUSY row as OFFLINE, so no queue waits on a closed laptop", () => {
    expect(effectivePresence({ status: "BUSY", lastSeenAt: stale }, NOW).status).toBe("OFFLINE");
  });

  it("reports a stale AWAY row as OFFLINE, and drops the window with it", () => {
    const out = effectivePresence(
      { status: "AWAY", lastSeenAt: stale, awayUntil: new Date(NOW.getTime() + 3600_000) },
      NOW,
    );
    expect(out).toEqual({ status: "OFFLINE", awayUntil: null });
  });

  it("does not flicker offline one beat before the threshold", () => {
    const justInside = new Date(NOW.getTime() - PRESENCE_STALE_AFTER_MS + 1000);
    expect(effectivePresence({ status: "ONLINE", lastSeenAt: justInside }, NOW).status).toBe("ONLINE");
  });

  // ── The away window ends by itself ───────────────────────

  it("keeps AWAY, and its window, while the window is open", () => {
    const until = new Date(NOW.getTime() + 3600_000);
    expect(effectivePresence({ status: "AWAY", lastSeenAt: fresh, awayUntil: until }, NOW)).toEqual({
      status: "AWAY",
      awayUntil: until.toISOString(),
    });
  });

  it("turns an elapsed AWAY window back into ONLINE with no reaper", () => {
    // Otherwise "away until 11:00" would still be showing at 15:00 for an agent
    // who is demonstrably at their desk, because they are still heartbeating.
    const until = new Date(NOW.getTime() - 60_000);
    expect(effectivePresence({ status: "AWAY", lastSeenAt: fresh, awayUntil: until }, NOW)).toEqual({
      status: "ONLINE",
      awayUntil: null,
    });
  });

  it("allows AWAY with no stated return time", () => {
    expect(effectivePresence({ status: "AWAY", lastSeenAt: fresh, awayUntil: null }, NOW)).toEqual({
      status: "AWAY",
      awayUntil: null,
    });
  });

  it("never returns awayUntil beside a non-AWAY status", () => {
    for (const status of ["ONLINE", "BUSY", "OFFLINE"]) {
      const out = effectivePresence(
        { status, lastSeenAt: fresh, awayUntil: new Date(NOW.getTime() + 3600_000) },
        NOW,
      );
      expect(out.awayUntil).toBeNull();
    }
  });

  it("falls back to OFFLINE for a status it does not recognise", () => {
    // A value written by an older or newer deployment must not be rendered
    // as-is into a UI that has no case for it.
    expect(effectivePresence({ status: "TELEPORTING", lastSeenAt: fresh }, NOW).status).toBe("OFFLINE");
  });
});

describe("declarePresence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.agentPresence.upsert.mockResolvedValue({});
  });

  it("stores an away window with AWAY", async () => {
    const until = new Date(NOW.getTime() + 3600_000);
    await declarePresence("usr_1", "ten_1", "AWAY", until);
    expect(prismaMock.agentPresence.upsert.mock.calls[0][0].update).toMatchObject({
      status: "AWAY",
      awayUntil: until,
    });
  });

  it("clears the window on any other status", async () => {
    // A window left behind by an earlier AWAY would reappear the next time
    // somebody set AWAY without one, and claim a return time nobody gave.
    for (const status of ["ONLINE", "BUSY", "OFFLINE"] as const) {
      vi.clearAllMocks();
      await declarePresence("usr_1", "ten_1", status, new Date(NOW.getTime() + 3600_000));
      expect(prismaMock.agentPresence.upsert.mock.calls[0][0].update.awayUntil).toBeNull();
    }
  });

  it("keys on the agent, so one agent's writes cannot disturb another's", async () => {
    await declarePresence("usr_1", "ten_1", "BUSY");
    expect(prismaMock.agentPresence.upsert.mock.calls[0][0].where).toEqual({ agentId: "usr_1" });
  });
});
