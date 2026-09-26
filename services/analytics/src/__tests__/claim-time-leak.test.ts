/**
 * ★ A claim measures ONE reply, and then it is gone.
 *
 * `claim_time` was SET with a 7-day TTL and read with GET, never deleted. So
 * every agent reply for the next week measured from the ORIGINAL claim: the
 * second reply in a thread reported a larger "response time" than the first, the
 * fifth reported hours, and the daily mean drifted upward with conversation
 * LENGTH rather than with responsiveness.
 *
 * Beside a person's name that made whoever handles the long difficult cases look
 * slowest — on a screen built specifically not to rank anyone.
 *
 * The property this file exists for is only visible by invoking the handler
 * TWICE: one claim must produce exactly one measurement.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  store: new Map<string, string>(),
  pushed: [] as Array<{ key: string; value: string }>,
  getdelCalls: 0,
  getCalls: 0,
}));

vi.mock("@chatcenter/shared", () => ({
  createWorker: () => ({ on: () => undefined }),
  getRedis: () => ({
    hincrby: async () => 1,
    expire: async () => 1,
    set: async (k: string, v: string) => { state.store.set(k, v); return "OK"; },
    get: async (k: string) => { state.getCalls += 1; return state.store.get(k) ?? null; },
    getdel: async (k: string) => {
      state.getdelCalls += 1;
      const v = state.store.get(k) ?? null;
      state.store.delete(k);
      return v;
    },
    lpush: async (key: string, value: string) => { state.pushed.push({ key, value }); return 1; },
  }),
}));

import { processAnalyticsEvent } from "../workers/analytics.worker";

const job = (event: string, data: any, timestamp: string) =>
  ({ data: { tenantId: "t1", event, data, timestamp } } as any);

beforeEach(() => {
  state.store.clear();
  state.pushed = [];
  state.getdelCalls = 0;
  state.getCalls = 0;
});

describe("★ one claim, one measurement", () => {
  it("records the first reply after a claim", async () => {
    await processAnalyticsEvent(job("conversation_claimed", { conversationId: "cv1", agentId: "a1" }, "2026-09-26T10:00:00.000Z"));
    await processAnalyticsEvent(job("agent_response", { conversationId: "cv1", agentId: "a1" }, "2026-09-26T10:00:30.000Z"));

    const times = state.pushed.filter((p) => p.key.includes("response_times"));
    expect(times.length).toBeGreaterThan(0);
    expect(times[0].value).toBe("30000");
  });

  it("★ a SECOND reply records NOTHING — the drift is impossible now", async () => {
    await processAnalyticsEvent(job("conversation_claimed", { conversationId: "cv1", agentId: "a1" }, "2026-09-26T10:00:00.000Z"));
    await processAnalyticsEvent(job("agent_response", { conversationId: "cv1", agentId: "a1" }, "2026-09-26T10:00:30.000Z"));
    state.pushed = [];

    // Twenty minutes later, same conversation. Under GET this recorded 1,200,000ms
    // measured from the original claim, and the daily mean grew with how long the
    // conversation ran.
    await processAnalyticsEvent(job("agent_response", { conversationId: "cv1", agentId: "a1" }, "2026-09-26T10:20:00.000Z"));

    expect(state.pushed.filter((p) => p.key.includes("response_times"))).toHaveLength(0);
  });

  it("★ reads the key with GETDEL, not GET", async () => {
    await processAnalyticsEvent(job("conversation_claimed", { conversationId: "cv1", agentId: "a1" }, "2026-09-26T10:00:00.000Z"));
    await processAnalyticsEvent(job("agent_response", { conversationId: "cv1", agentId: "a1" }, "2026-09-26T10:00:30.000Z"));

    // Atomic read-and-delete: a plain GET followed by a DEL would leave a window
    // in which two concurrent replies both measure from the same claim.
    expect(state.getdelCalls).toBe(1);
    expect(state.getCalls).toBe(0);
  });

  it("a reply with no claim records nothing at all", async () => {
    await processAnalyticsEvent(job("agent_response", { conversationId: "cv1", agentId: "a1" }, "2026-09-26T10:00:30.000Z"));

    // An AI-answered conversation has no claim. Recording a zero here would put
    // "instant" into an average that is about humans.
    expect(state.pushed.filter((p) => p.key.includes("response_times"))).toHaveLength(0);
  });

  it("a fresh claim starts a new measurement", async () => {
    await processAnalyticsEvent(job("conversation_claimed", { conversationId: "cv1", agentId: "a1" }, "2026-09-26T10:00:00.000Z"));
    await processAnalyticsEvent(job("agent_response", { conversationId: "cv1", agentId: "a1" }, "2026-09-26T10:00:30.000Z"));
    state.pushed = [];

    // Released and re-claimed later: that IS a new response time.
    await processAnalyticsEvent(job("conversation_claimed", { conversationId: "cv1", agentId: "a2" }, "2026-09-26T11:00:00.000Z"));
    await processAnalyticsEvent(job("agent_response", { conversationId: "cv1", agentId: "a2" }, "2026-09-26T11:00:05.000Z"));

    const times = state.pushed.filter((p) => p.key.includes("response_times"));
    expect(times.length).toBeGreaterThan(0);
    expect(times[0].value).toBe("5000");
  });
});
