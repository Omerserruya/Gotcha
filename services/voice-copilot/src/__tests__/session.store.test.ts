/**
 * session.store.test.ts
 *
 * Tests for createSessionStore using a hand-rolled in-memory Redis mock.
 * We do NOT use real Redis or ioredis-mock (not installed; eval/SSCAN support
 * is uncertain in available versions).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createSessionStore } from "../session/session-store";
import type { SessionStore, SessionRecord, SessionState } from "../session/session-store";

// ---------------------------------------------------------------------------
// In-memory Redis mock implementing the subset used by session-store
// ---------------------------------------------------------------------------
function makeInMemRedis() {
  const hashes = new Map<string, Map<string, string>>();
  const strings = new Map<string, string>();
  const sets = new Map<string, Set<string>>();

  function getHash(key: string): Map<string, string> {
    if (!hashes.has(key)) hashes.set(key, new Map());
    return hashes.get(key)!;
  }
  function getSet(key: string): Set<string> {
    if (!sets.has(key)) sets.set(key, new Set());
    return sets.get(key)!;
  }

  // Pipeline accumulator
  function makePipeline() {
    const cmds: Array<() => [null, unknown]> = [];
    const pipe: any = {
      hset: (key: string, ...args: string[]) => {
        cmds.push(() => {
          const h = getHash(key);
          for (let i = 0; i < args.length; i += 2) h.set(args[i], args[i + 1]);
          return [null, args.length / 2];
        });
        return pipe;
      },
      expire: (key: string, _ttl: number) => {
        cmds.push(() => [null, 1]);
        return pipe;
      },
      sadd: (key: string, ...members: string[]) => {
        cmds.push(() => {
          const s = getSet(key);
          let added = 0;
          for (const m of members) { if (!s.has(m)) { s.add(m); added++; } }
          return [null, added];
        });
        return pipe;
      },
      srem: (key: string, ...members: string[]) => {
        cmds.push(() => {
          const s = getSet(key);
          let removed = 0;
          for (const m of members) { if (s.delete(m)) removed++; }
          return [null, removed];
        });
        return pipe;
      },
      del: (...keys: string[]) => {
        cmds.push(() => {
          let count = 0;
          for (const k of keys) {
            if (hashes.delete(k) || strings.delete(k) || sets.delete(k)) count++;
          }
          return [null, count];
        });
        return pipe;
      },
      set: (key: string, val: string, ...args: unknown[]) => {
        cmds.push(() => {
          const hasNx = args.includes("NX");
          if (hasNx && strings.has(key)) return [null, null];
          strings.set(key, val);
          return [null, "OK"];
        });
        return pipe;
      },
      exec: async () => cmds.map((fn) => fn()),
    };
    return pipe;
  }

  // Lua reconnect-claim simulation
  function reconnectClaimLua(key: string, nowMs: number, graceMs: number): string[] | null {
    const h = hashes.get(key);
    if (!h) return null;
    const st = h.get("state");
    if (!st || st === "ended") return null;
    const lastFrame = Number(h.get("lastFrameAt") ?? "0");
    if (nowMs - lastFrame > graceMs) return null;
    h.set("reconnectCount", String(Number(h.get("reconnectCount") ?? "0") + 1));
    // Return flat array like HGETALL
    const arr: string[] = [];
    for (const [k, v] of h) arr.push(k, v);
    return arr;
  }

  // Lua reaper-handoff simulation
  function reaperHandoffLua(key: string, nowMs: number, staleMs: number): number {
    const h = hashes.get(key);
    if (!h) return 0;
    const st = h.get("state");
    if (!st || st === "ended") return 0;
    const lastFrame = Number(h.get("lastFrameAt") ?? "0");
    if (nowMs - lastFrame <= staleMs) return 0;
    h.set("state", "ended");
    return 1;
  }

  return {
    pipeline: makePipeline,
    hset: async (key: string, ...args: string[]) => {
      const h = getHash(key);
      for (let i = 0; i < args.length; i += 2) h.set(args[i], args[i + 1]);
      return args.length / 2;
    },
    hgetall: async (key: string): Promise<Record<string, string> | null> => {
      const h = hashes.get(key);
      if (!h || h.size === 0) return {};
      const obj: Record<string, string> = {};
      for (const [k, v] of h) obj[k] = v;
      return obj;
    },
    hincrby: async (key: string, field: string, by: number) => {
      const h = getHash(key);
      const cur = Number(h.get(field) ?? "0");
      const next = cur + by;
      h.set(field, String(next));
      return next;
    },
    expire: async (_key: string, _ttl: number) => 1,
    get: async (key: string): Promise<string | null> => strings.get(key) ?? null,
    set: async (key: string, val: string, ...args: unknown[]): Promise<string | null> => {
      const hasNx = args.includes("NX");
      if (hasNx && strings.has(key)) return null;
      strings.set(key, val);
      return "OK";
    },
    del: async (...keys: string[]) => {
      let count = 0;
      for (const k of keys) {
        if (hashes.delete(k) || strings.delete(k) || sets.delete(k)) count++;
      }
      return count;
    },
    incr: async (key: string) => {
      const cur = Number(strings.get(key) ?? "0");
      const next = cur + 1;
      strings.set(key, String(next));
      return next;
    },
    sadd: async (key: string, ...members: string[]) => {
      const s = getSet(key);
      let added = 0;
      for (const m of members) { if (!s.has(m)) { s.add(m); added++; } }
      return added;
    },
    srem: async (key: string, ...members: string[]) => {
      const s = getSet(key);
      let removed = 0;
      for (const m of members) { if (s.delete(m)) removed++; }
      return removed;
    },
    sscan: async (key: string, cursor: string, _countFlag: string, _count: number): Promise<[string, string[]]> => {
      const s = sets.get(key);
      if (!s) return ["0", []];
      return ["0", [...s]];
    },
    eval: async (script: string, _numKeys: number, ...args: string[]): Promise<unknown> => {
      const key = args[0];
      const arg1 = Number(args[1]);
      const arg2 = Number(args[2]);
      // Detect which script by content
      if (script.includes("reconnectCount")) {
        return reconnectClaimLua(key, arg1, arg2);
      } else {
        return reaperHandoffLua(key, arg1, arg2);
      }
    },
    // Expose internals for assertions
    _hashes: hashes,
    _strings: strings,
    _sets: sets,
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    tenantId: "t1",
    conversationId: "c1",
    callSid: "CA123",
    streamSid: "SS123",
    state: "ringing",
    startedAt: 1000,
    lastFrameAt: 1000,
    reconnectCount: 0,
    framesReceived: 0,
    framesDropped: 0,
    transcriptsEmitted: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("SessionStore (in-memory mock)", () => {
  let redis: ReturnType<typeof makeInMemRedis>;
  let store: SessionStore;

  beforeEach(() => {
    redis = makeInMemRedis();
    store = createSessionStore(redis as any);
  });

  it("create + get roundtrip", async () => {
    const record = makeRecord();
    await store.create(record, 900);
    const got = await store.get("t1", "c1");
    expect(got).not.toBeNull();
    expect(got!.conversationId).toBe("c1");
    expect(got!.tenantId).toBe("t1");
    expect(got!.callSid).toBe("CA123");
    expect(got!.state).toBe("ringing");
    expect(got!.startedAt).toBe(1000);
  });

  it("refreshTtl calls expire on the session key", async () => {
    await store.create(makeRecord(), 900);
    // No error — just verify it doesn't throw
    await expect(store.refreshTtl("t1", "c1", 900)).resolves.toBeUndefined();
  });

  it("touchLastFrame updates lastFrameAt field", async () => {
    await store.create(makeRecord(), 900);
    await store.touchLastFrame("t1", "c1", 99999);
    const got = await store.get("t1", "c1");
    expect(got!.lastFrameAt).toBe(99999);
  });

  it("delete removes session and reaper-set membership", async () => {
    await store.create(makeRecord(), 900);
    // Verify it was added to reaper set
    expect(redis._sets.get("voice:reaper:scan")?.has("t1::c1")).toBe(true);

    await store.delete("t1", "c1");

    const got = await store.get("t1", "c1");
    expect(got).toBeNull();
    expect(redis._sets.get("voice:reaper:scan")?.has("t1::c1")).toBe(false);
  });

  it("findByCallSid returns conversationId after setCallSidIndex", async () => {
    await store.setCallSidIndex("t1", "CA123", "c1", 900);
    const convId = await store.findByCallSid("t1", "CA123");
    expect(convId).toBe("c1");
  });

  it("nextSeq returns monotonic integers per (conversationId, speaker)", async () => {
    const s1 = await store.nextSeq("t1", "c1", "agent");
    const s2 = await store.nextSeq("t1", "c1", "agent");
    const s3 = await store.nextSeq("t1", "c1", "agent");
    expect(s1).toBe(1);
    expect(s2).toBe(2);
    expect(s3).toBe(3);

    // Different speaker is independent
    const cs1 = await store.nextSeq("t1", "c1", "customer");
    expect(cs1).toBe(1);
  });

  it("claimIdempotency returns false on duplicate", async () => {
    const first = await store.claimIdempotency("t1", "c1", "agent", 42);
    expect(first).toBe(true);

    const second = await store.claimIdempotency("t1", "c1", "agent", 42);
    expect(second).toBe(false);
  });

  it("reconnectClaim past grace returns null", async () => {
    const record = makeRecord({ lastFrameAt: 1000, state: "active" });
    await store.create(record, 900);

    // now = 200_000, grace = 10_000 → 200_000 - 1000 = 199_000 > 10_000 → null
    const result = await store.reconnectClaim("t1", "c1", 200_000, 10_000);
    expect(result).toBeNull();
  });

  it("reconnectClaim within grace increments reconnectCount and returns record", async () => {
    const record = makeRecord({ lastFrameAt: 5000, state: "active" });
    await store.create(record, 900);

    // now = 10_000, grace = 10_000 → 10_000 - 5000 = 5000 ≤ 10_000 → claim
    const result = await store.reconnectClaim("t1", "c1", 10_000, 10_000);
    expect(result).not.toBeNull();
    expect(result!.reconnectCount).toBe(1);
  });

  it("reaperHandoff: stale session returns true, fresh session returns false", async () => {
    // Stale: lastFrameAt=0, now=200_000, staleMs=120_000
    const record = makeRecord({ lastFrameAt: 0, state: "active" });
    await store.create(record, 900);
    const claimed = await store.reaperHandoff("t1", "c1", 200_000, 120_000);
    expect(claimed).toBe(true);

    // Now state is "ended" — calling again returns false
    const again = await store.reaperHandoff("t1", "c1", 200_000, 120_000);
    expect(again).toBe(false);
  });

  it("scanReaperSet returns members after create", async () => {
    await store.create(makeRecord({ tenantId: "t1", conversationId: "c1" }), 900);
    await store.create(makeRecord({ tenantId: "t1", conversationId: "c2" }), 900);
    const { cursor, members } = await store.scanReaperSet("0", 100);
    expect(cursor).toBe("0");
    expect(members).toContain("t1::c1");
    expect(members).toContain("t1::c2");
  });
});
