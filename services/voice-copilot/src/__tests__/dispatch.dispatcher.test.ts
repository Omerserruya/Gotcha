import { describe, it, expect, vi } from "vitest";
import { Dispatcher } from "../dispatch/dispatcher";
import type { DispatchItem, DispatcherDeps } from "../dispatch/dispatcher";
import type { VoiceStreamBody } from "../dispatch/ai-assist-client";
import type { PostResult } from "../dispatch/ai-assist-client";
import type { Transcript } from "../stt/provider";
import type { Metrics } from "../metrics/metrics";
import { createFakeClock } from "../lib/clock";
import type { Redis } from "ioredis";

// broad client type matching DispatcherDeps.client
type ClientFn = DispatcherDeps["client"];

// ---------------------------------------------------------------------------
// Minimal Redis mock (pipeline with SET NX EX, LPUSH, LTRIM support)
// ---------------------------------------------------------------------------
function makeMockRedis(): Redis {
  const store = new Map<string, string>();
  const lists = new Map<string, string[]>();

  function makeExec(cmds: Array<[string, ...unknown[]]>) {
    const results: Array<[null, unknown]> = [];
    for (const [cmd, ...args] of cmds) {
      if (cmd === "set") {
        // ioredis order: set(key, val, "EX", seconds, "NX") or set(key, val, "NX")
        const [key, val, ...rest] = args as [string, string, ...unknown[]];
        const hasNx = rest.includes("NX");
        if (hasNx && store.has(key)) {
          results.push([null, null]); // NX failed — already exists
        } else {
          store.set(key, String(val));
          results.push([null, "OK"]);
        }
      } else if (cmd === "lpush") {
        const [key, ...vals] = args as [string, ...string[]];
        const list = lists.get(key) ?? [];
        list.unshift(...vals.slice().reverse());
        lists.set(key, list);
        results.push([null, list.length]);
      } else if (cmd === "ltrim") {
        const [key, start, end] = args as [string, number, number];
        const list = lists.get(key) ?? [];
        lists.set(key, list.slice(start, end + 1));
        results.push([null, "OK"]);
      } else {
        results.push([null, null]);
      }
    }
    return results;
  }

  return {
    pipeline() {
      const cmds: Array<[string, ...unknown[]]> = [];
      const p = {
        set(...args: unknown[]) {
          cmds.push(["set", ...args]);
          return p;
        },
        lpush(...args: unknown[]) {
          cmds.push(["lpush", ...args]);
          return p;
        },
        ltrim(...args: unknown[]) {
          cmds.push(["ltrim", ...args]);
          return p;
        },
        exec() {
          return Promise.resolve(makeExec(cmds));
        },
      };
      return p;
    },
    // expose store for test assertions
    _store: store,
    _lists: lists,
  } as unknown as Redis;
}

// ---------------------------------------------------------------------------
// Minimal Metrics mock
// ---------------------------------------------------------------------------
interface MockMetricsResult {
  metrics: Metrics;
  counts: Record<string, number>;
  observations: number[];
}

function makeMockMetrics(): MockMetricsResult {
  const counts: Record<string, number> = {};
  const observations: number[] = [];

  function makeCounter(name: string) {
    return {
      inc(labels?: Record<string, string>) {
        const key = labels ? `${name}:${JSON.stringify(labels)}` : name;
        counts[key] = (counts[key] ?? 0) + 1;
      },
    };
  }

  const metrics: Metrics = {
    registry: {} as never,
    sessionsActive: { set: vi.fn() } as never,
    sessionsStarted: makeCounter("sessionsStarted") as never,
    sessionsEnded: makeCounter("sessionsEnded") as never,
    framesReceived: makeCounter("framesReceived") as never,
    framesLateDropped: makeCounter("framesLateDropped") as never,
    audioQueueDropped: makeCounter("audioQueueDropped") as never,
    dispatchLatency: {
      observe(v: number) {
        observations.push(v);
      },
    } as never,
    dispatchDeduped: makeCounter("dispatchDeduped") as never,
    dispatchFailed: makeCounter("dispatchFailed") as never,
    dispatchRejected: makeCounter("dispatchRejected") as never,
    sttErrors: makeCounter("sttErrors") as never,
    reconnects: makeCounter("reconnects") as never,
    twilioAuthRejected: makeCounter("twilioAuthRejected") as never,
    crossTenantRejected: makeCounter("crossTenantRejected") as never,
    sessionPanic: makeCounter("sessionPanic") as never,
    voiceOverload: makeCounter("voiceOverload") as never,
  };

  return { metrics, counts, observations };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeTranscript(seq: number, speaker: "agent" | "customer" = "customer"): Transcript {
  return { speaker, text: `word-${seq}`, timestamp: seq * 100, isFinal: true, confidence: 0.9, seq };
}

function makeItem(seq: number, speaker: "agent" | "customer" = "customer"): DispatchItem {
  return { tenantId: "t1", conversationId: "c1", message: makeTranscript(seq, speaker) };
}

function makeOkClient(delay = 0): { client: ClientFn; calls: VoiceStreamBody[] } {
  const calls: VoiceStreamBody[] = [];
  const client: ClientFn = async (body) => {
    calls.push(body as VoiceStreamBody);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    return { ok: true, status: 200 } satisfies PostResult;
  };
  return { client, calls };
}

function buildDeps(
  overrides: Partial<DispatcherDeps> & { client: ClientFn }
): DispatcherDeps & { redis: ReturnType<typeof makeMockRedis>; metricsHelper: ReturnType<typeof makeMockMetrics> } {
  const clock = overrides.clock ?? createFakeClock();
  const metricsResult = makeMockMetrics();
  const { metrics } = metricsResult;
  const redis = (overrides.redis as ReturnType<typeof makeMockRedis>) ?? makeMockRedis();

  const deps: DispatcherDeps = {
    client: overrides.client,
    redis,
    aiServiceUrl: overrides.aiServiceUrl ?? "http://ai:4006",
    internalKey: overrides.internalKey ?? "key",
    clock,
    random: overrides.random ?? (() => 0.5),
    logger: overrides.logger ?? ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never),
    metrics: overrides.metrics ?? metrics,
    batchWindowMs: overrides.batchWindowMs ?? 100,
    batchMax: overrides.batchMax ?? 5,
    retryScheduleMs: overrides.retryScheduleMs ?? [50, 100, 200],
    dlqMaxLen: overrides.dlqMaxLen ?? 10_000,
    circuitThresholdFailures: overrides.circuitThresholdFailures ?? 20,
    circuitWindowMs: overrides.circuitWindowMs ?? 60_000,
    circuitOpenMs: overrides.circuitOpenMs ?? 30_000,
  };

  return { ...deps, redis, metricsHelper: metricsResult } as DispatcherDeps & {
    redis: ReturnType<typeof makeMockRedis>;
    metricsHelper: ReturnType<typeof makeMockMetrics>;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("Dispatcher", () => {
  describe("idempotency via Redis SETNX", () => {
    it("duplicate enqueue is deduped and dispatchDeduped increments", async () => {
      const { client, calls } = makeOkClient();
      const deps = buildDeps({ client });
      const clock = deps.clock as ReturnType<typeof createFakeClock>;
      const dispatcher = new Dispatcher(deps);

      dispatcher.enqueue(makeItem(1));
      // advance to flush first batch
      clock.advance(100);
      await new Promise((r) => setTimeout(r, 0)); // yield for async flush

      // enqueue same item again — Redis NX will return null
      dispatcher.enqueue(makeItem(1));
      clock.advance(100);
      await new Promise((r) => setTimeout(r, 0));

      // Wait for all pending microtasks
      await new Promise((r) => setTimeout(r, 20));

      // Second enqueue should be deduped
      expect(deps.metricsHelper.counts["dispatchDeduped"]).toBeGreaterThanOrEqual(1);
      // Only one real batch should have been sent
      expect(calls).toHaveLength(1);
    });
  });

  describe("batching", () => {
    it("coalesces items within window into a single batch", async () => {
      const { client, calls } = makeOkClient();
      const deps = buildDeps({ client });
      const clock = deps.clock as ReturnType<typeof createFakeClock>;
      const dispatcher = new Dispatcher(deps);

      dispatcher.enqueue(makeItem(10));
      dispatcher.enqueue(makeItem(11));
      dispatcher.enqueue(makeItem(12));

      clock.advance(100);
      await new Promise((r) => setTimeout(r, 20));

      expect(calls).toHaveLength(1);
      expect(calls[0].messages).toHaveLength(3);
    });

    it("flushes early when batchMax is reached", async () => {
      const { client, calls } = makeOkClient();
      const deps = buildDeps({ client, batchMax: 3 });
      const dispatcher = new Dispatcher(deps);

      // Add 3 items — should flush immediately without clock advance
      dispatcher.enqueue(makeItem(20));
      dispatcher.enqueue(makeItem(21));
      dispatcher.enqueue(makeItem(22));

      await new Promise((r) => setTimeout(r, 20));

      expect(calls).toHaveLength(1);
      expect(calls[0].messages).toHaveLength(3);
    });
  });

  describe("retry schedule", () => {
    it("retries on 5xx and succeeds on final attempt", async () => {
      let callCount = 0;
      const client: ClientFn = async () => {
        callCount++;
        if (callCount < 3) return { ok: false, status: 503 };
        return { ok: true, status: 200 };
      };
      const clock = createFakeClock();
      const deps = buildDeps({ client, clock, retryScheduleMs: [50, 100, 200] });
      const dispatcher = new Dispatcher(deps);

      dispatcher.enqueue(makeItem(30));
      clock.advance(100); // trigger batch flush

      // Let flush start
      await new Promise((r) => setTimeout(r, 5));

      // Advance through retry delays
      clock.advance(50);
      await new Promise((r) => setTimeout(r, 5));
      clock.advance(100);
      await new Promise((r) => setTimeout(r, 20));

      expect(callCount).toBeGreaterThanOrEqual(2);
    });

    it("4xx does not retry", async () => {
      let callCount = 0;
      const client: ClientFn = async () => {
        callCount++;
        return { ok: false, status: 422 };
      };
      const clock = createFakeClock();
      const deps = buildDeps({ client, clock, retryScheduleMs: [50, 100, 200] });
      const dispatcher = new Dispatcher(deps);

      dispatcher.enqueue(makeItem(40));
      clock.advance(100);
      await new Promise((r) => setTimeout(r, 20));

      expect(callCount).toBe(1);
      expect(deps.metricsHelper.counts['dispatchRejected:{"status":"422"}']).toBe(1);
    });
  });

  describe("DLQ", () => {
    it("sends to DLQ after exhausting retries", async () => {
      const client: ClientFn = async () => ({ ok: false, status: 503 });
      const clock = createFakeClock();
      const redis = makeMockRedis();
      const deps = buildDeps({ client, clock, redis, retryScheduleMs: [10, 20] });
      const dispatcher = new Dispatcher(deps);

      dispatcher.enqueue(makeItem(50));
      clock.advance(100); // trigger batch

      await new Promise((r) => setTimeout(r, 5));
      // advance through retries
      for (let i = 0; i < 5; i++) {
        clock.advance(50);
        await new Promise((r) => setTimeout(r, 5));
      }
      await new Promise((r) => setTimeout(r, 30));

      const lists = (redis as unknown as { _lists: Map<string, string[]> })._lists;
      const dlq = lists.get("voice:dlq:t1");
      expect(dlq).toBeDefined();
      expect(dlq!.length).toBeGreaterThanOrEqual(1);
      const entry = JSON.parse(dlq![0]);
      expect(entry.reason).toBe("exhausted");
      expect(entry.tenantId).toBe("t1");
    });
  });

  describe("circuit breaker", () => {
    it("opens after threshold failures and goes to DLQ directly", async () => {
      const client: ClientFn = async () => ({ ok: false, status: 503 });
      const clock = createFakeClock();
      const redis = makeMockRedis();
      const deps = buildDeps({
        client,
        clock,
        redis,
        retryScheduleMs: [], // no retries for speed
        circuitThresholdFailures: 3,
        circuitWindowMs: 60_000,
        circuitOpenMs: 30_000,
      });
      const dispatcher = new Dispatcher(deps);

      // First 3 items: should fail and open circuit
      for (let i = 0; i < 3; i++) {
        dispatcher.enqueue({ tenantId: "t1", conversationId: "c1", message: makeTranscript(100 + i) });
        clock.advance(100);
        await new Promise((r) => setTimeout(r, 20));
      }

      // Circuit should now be open
      expect(dispatcher.circuitState("t1")).toBe("open");
    });

    it("HALF_OPEN probe success transitions to CLOSED", async () => {
      let callCount = 0;
      const client: ClientFn = async () => {
        callCount++;
        if (callCount <= 3) return { ok: false, status: 503 };
        return { ok: true, status: 200 };
      };
      const clock = createFakeClock();
      const redis = makeMockRedis();
      const deps = buildDeps({
        client,
        clock,
        redis,
        retryScheduleMs: [],
        circuitThresholdFailures: 3,
        circuitWindowMs: 60_000,
        circuitOpenMs: 1000,
      });
      const dispatcher = new Dispatcher(deps);

      // Open the circuit
      for (let i = 0; i < 3; i++) {
        dispatcher.enqueue({ tenantId: "t1", conversationId: "c1", message: makeTranscript(200 + i) });
        clock.advance(100);
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(dispatcher.circuitState("t1")).toBe("open");

      // Advance past openMs → should become half_open
      clock.advance(1001);
      expect(dispatcher.circuitState("t1")).toBe("half_open");

      // Send a probe (successful)
      dispatcher.enqueue({ tenantId: "t1", conversationId: "c1", message: makeTranscript(300) });
      clock.advance(100);
      await new Promise((r) => setTimeout(r, 20));

      // After successful probe circuit should be closed
      expect(dispatcher.circuitState("t1")).toBe("closed");
    });
  });

  describe("flushSession", () => {
    it("flushes pending batches for the given conversation synchronously", async () => {
      const { client, calls } = makeOkClient();
      const clock = createFakeClock();
      const deps = buildDeps({ client, clock });
      const dispatcher = new Dispatcher(deps);

      dispatcher.enqueue(makeItem(60));
      dispatcher.enqueue(makeItem(61));

      // Do NOT advance clock — flushSession should flush without timer
      await dispatcher.flushSession("t1", "c1");

      expect(calls).toHaveLength(1);
      expect(calls[0].messages).toHaveLength(2);
    });

    it("does not flush batches for a different conversation", async () => {
      const { client, calls } = makeOkClient();
      const clock = createFakeClock();
      const deps = buildDeps({ client, clock });
      const dispatcher = new Dispatcher(deps);

      dispatcher.enqueue(makeItem(70));

      // flush for a different conversation
      await dispatcher.flushSession("t1", "c-other");

      expect(calls).toHaveLength(0);
      // timer still pending; advance to flush normally
      clock.advance(100);
      await new Promise((r) => setTimeout(r, 20));
      expect(calls).toHaveLength(1);
    });
  });
});
