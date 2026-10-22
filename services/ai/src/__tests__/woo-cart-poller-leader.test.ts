/**
 * ★ One WooCommerce poll per tick across every replica (2026-10-09 review:
 * each replica's setInterval polled every store). The tick's Redis lock
 * (SET NX PX) decides: the first replica polls, the others skip; the lock is
 * kept until it expires, a minute before the next tick, so a late replica
 * cannot poll the same window again; once it expires, the next tick polls.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ store: new Map<string, { v: string; until: number }>(), now: 0, polled: 0, setArgs: [] as any[] }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    // A Redis double with real SET ... PX ms NX semantics, on a fake clock.
    getRedis: () => ({
      set: async (k: string, v: string, ...opts: any[]) => {
        H.setArgs.push([k, v, ...opts]);
        const px = opts[opts.indexOf("PX") + 1];
        const cur = H.store.get(k);
        if (opts.includes("NX") && cur && cur.until > H.now) return null;
        H.store.set(k, { v, until: H.now + Number(px) });
        return "OK";
      },
    }),
    prisma: {
      // No tenant has Woo cart events on: a poll that runs touches nothing else.
      chatbotFlow: { findMany: async () => { H.polled++; return []; } },
    },
  };
});

import { pollWooCartsIfLeader, startWooCartPoller, WOO_TICK_LOCK_KEY } from "../services/woo-cart-poller.service";

const TICK = 15 * 60_000;
beforeEach(() => { H.store = new Map(); H.now = 0; H.polled = 0; H.setArgs = []; });

describe("★ exactly one replica polls a tick", () => {
  it("two replicas on the same tick: the first polls, the second skips", async () => {
    const a = await pollWooCartsIfLeader(new Date(), "replica-a");
    const b = await pollWooCartsIfLeader(new Date(), "replica-b");
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    expect(H.polled).toBe(1);
    expect(H.setArgs[0]).toEqual([WOO_TICK_LOCK_KEY, "replica-a", "PX", TICK - 60_000, "NX"]);
  });

  it("a replica whose timer fires a minute later in the same window still skips; the next tick polls", async () => {
    await pollWooCartsIfLeader(new Date(), "replica-a");
    H.now = 60_000;
    expect(await pollWooCartsIfLeader(new Date(), "replica-b")).toBeNull();
    H.now = TICK;
    expect(await pollWooCartsIfLeader(new Date(), "replica-b")).not.toBeNull();
    expect(H.polled).toBe(2);
  });
});

describe("★ the replica's timer goes through the lock", () => {
  it("each tick asks for the lock before polling", async () => {
    vi.useFakeTimers();
    try {
      startWooCartPoller();
      await vi.advanceTimersByTimeAsync(TICK);
      expect(H.setArgs.map((a) => a[0])).toEqual([WOO_TICK_LOCK_KEY]);
      expect(H.polled).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
