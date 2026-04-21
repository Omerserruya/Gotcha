import { describe, it, expect, vi, beforeEach } from "vitest";
import { Reaper } from "../session/reaper";
import type { ReaperDeps } from "../session/reaper";
import type { SessionStore } from "../session/session-store";
import { createFakeClock, type FakeClock } from "../lib/clock";
import type { Metrics } from "../metrics/metrics";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockStore(overrides: Partial<SessionStore> = {}): SessionStore {
  return {
    create: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    updateState: vi.fn().mockResolvedValue(undefined),
    refreshTtl: vi.fn().mockResolvedValue(undefined),
    incrField: vi.fn().mockResolvedValue(undefined),
    touchLastFrame: vi.fn().mockResolvedValue(undefined),
    findByCallSid: vi.fn().mockResolvedValue(null),
    setCallSidIndex: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    nextSeq: vi.fn().mockResolvedValue(1),
    claimIdempotency: vi.fn().mockResolvedValue(true),
    reconnectClaim: vi.fn().mockResolvedValue(null),
    reaperHandoff: vi.fn().mockResolvedValue(false),
    addToReaperSet: vi.fn().mockResolvedValue(undefined),
    removeFromReaperSet: vi.fn().mockResolvedValue(undefined),
    scanReaperSet: vi.fn().mockResolvedValue({ cursor: "0", members: [] }),
    ...overrides,
  };
}

function makeMockMetrics(): Metrics {
  const counter = () => ({ inc: vi.fn() });
  const gauge = () => ({ inc: vi.fn(), dec: vi.fn(), set: vi.fn() });
  const histogram = () => ({ observe: vi.fn() });
  return {
    registry: {} as any,
    sessionsActive: gauge() as any,
    sessionsStarted: counter() as any,
    sessionsEnded: counter() as any,
    framesReceived: counter() as any,
    framesLateDropped: counter() as any,
    audioQueueDropped: counter() as any,
    dispatchLatency: histogram() as any,
    dispatchDeduped: counter() as any,
    dispatchFailed: counter() as any,
    dispatchRejected: counter() as any,
    sttErrors: counter() as any,
    reconnects: counter() as any,
    twilioAuthRejected: counter() as any,
    crossTenantRejected: counter() as any,
    sessionPanic: counter() as any,
    voiceOverload: counter() as any,
  };
}

// Minimal Redis mock: only SET NX EX and DEL
function makeMockRedis() {
  const store = new Map<string, string>();
  return {
    set: vi.fn().mockImplementation(async (key: string, value: string, ...args: unknown[]) => {
      const hasNx = args.includes("NX");
      if (hasNx && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    }),
    del: vi.fn().mockImplementation(async (...keys: string[]) => {
      for (const k of keys) store.delete(k);
      return keys.length;
    }),
    _store: store,
  };
}

type TestDeps = {
  store: SessionStore;
  redis: ReturnType<typeof makeMockRedis>;
  clock: FakeClock;
  logger: any;
  metrics: Metrics;
  intervalMs: number;
  staleMs: number;
  endSession: ReturnType<typeof vi.fn>;
};

function makeDeps(overrides: Partial<ReaperDeps> = {}): TestDeps {
  const clock = createFakeClock();
  const redis = makeMockRedis();
  const store = makeMockStore();
  const metrics = makeMockMetrics();
  const endSession = vi.fn().mockResolvedValue(undefined);

  return {
    store,
    redis,
    clock,
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    metrics,
    intervalMs: 1000,
    staleMs: 120_000,
    endSession,
    ...overrides,
  } as unknown as TestDeps;
}

function makeReaper(deps: TestDeps): Reaper {
  return new Reaper(deps as unknown as ReaperDeps);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Reaper", () => {
  it("stale session: reaperHandoff returns true → endSession called once", async () => {
    const store = makeMockStore({
      scanReaperSet: vi.fn().mockResolvedValue({ cursor: "0", members: ["t1::c1"] }),
      reaperHandoff: vi.fn().mockResolvedValue(true),
    });
    const endSession = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ store, endSession });
    const reaper = makeReaper(deps);
    reaper.start();

    // Advance clock past interval to trigger tick
    deps.clock.advance(1001);
    // Settle async tick
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(endSession).toHaveBeenCalledTimes(1);
    expect(endSession).toHaveBeenCalledWith("t1", "c1", "reaper");
    expect(store.removeFromReaperSet).toHaveBeenCalledWith("t1", "c1");
    reaper.stop();
  });

  it("fresh session: reaperHandoff returns false → endSession NOT called", async () => {
    const store = makeMockStore({
      scanReaperSet: vi.fn().mockResolvedValue({ cursor: "0", members: ["t1::c1"] }),
      reaperHandoff: vi.fn().mockResolvedValue(false),
    });
    const endSession = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ store, endSession });
    const reaper = makeReaper(deps);
    reaper.start();

    deps.clock.advance(1001);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(endSession).not.toHaveBeenCalled();
    reaper.stop();
  });

  it("lock held by peer: second concurrent tick skips scan", async () => {
    // Simulate lock already held by setting the store to track redis.set calls
    const redis = makeMockRedis();
    // First call: acquired. Second call: already exists → null
    let callCount = 0;
    redis.set = vi.fn().mockImplementation(async (_key: string, _val: string, ...args: unknown[]) => {
      const hasNx = args.includes("NX");
      if (hasNx) {
        callCount++;
        if (callCount === 1) {
          redis._store.set(_key, _val);
          return "OK";
        } else {
          return null; // lock held
        }
      }
      return "OK";
    });

    const scanReaperSet = vi.fn().mockResolvedValue({ cursor: "0", members: ["t1::c1"] });
    const store = makeMockStore({ scanReaperSet, reaperHandoff: vi.fn().mockResolvedValue(true) });
    const endSession = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ store, endSession, redis: redis as any });
    const reaper = makeReaper(deps);
    reaper.start();

    // First tick
    deps.clock.advance(1001);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Second tick — lock held so scan should NOT run again
    deps.clock.advance(1001);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // scanReaperSet called only once (first tick); second tick sees lock = null → skipped
    expect(scanReaperSet).toHaveBeenCalledTimes(1);
    reaper.stop();
  });

  it("stop(): no more ticks after stop()", async () => {
    const scanReaperSet = vi.fn().mockResolvedValue({ cursor: "0", members: [] });
    const store = makeMockStore({ scanReaperSet });
    const deps = makeDeps({ store });
    const reaper = makeReaper(deps);
    reaper.start();

    deps.clock.advance(1001);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const callsBeforeStop = scanReaperSet.mock.calls.length;

    reaper.stop();

    deps.clock.advance(5000);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // No additional calls after stop
    expect(scanReaperSet.mock.calls.length).toBe(callsBeforeStop);
  });

  it("reaper handoff is idempotent: Lua returns true only once per stale session", async () => {
    let handoffCount = 0;
    const reaperHandoff = vi.fn().mockImplementation(async () => {
      if (handoffCount === 0) {
        handoffCount++;
        return true; // first call claims it
      }
      return false; // subsequent calls: already ended
    });
    const store = makeMockStore({
      scanReaperSet: vi.fn().mockResolvedValue({ cursor: "0", members: ["t1::c1"] }),
      reaperHandoff,
    });
    const endSession = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ store, endSession });
    const reaper = makeReaper(deps);
    reaper.start();

    // Two ticks
    deps.clock.advance(1001);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    deps.clock.advance(1001);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // endSession only called once (first tick)
    expect(endSession).toHaveBeenCalledTimes(1);
    reaper.stop();
  });
});
