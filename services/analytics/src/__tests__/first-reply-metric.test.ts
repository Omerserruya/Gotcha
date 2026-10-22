/**
 * "Average response time" measures the thing its name claims, at last.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * The old figure was `now - claim_time` on every agent reply. So it was:
 *   · measured from a HUMAN'S CLAIM, not the customer's message - forty minutes
 *     unclaimed then answered in ten seconds reported 10s
 *   · every reply, not the first
 *   · blind to AI-answered conversations, which have no claim
 *   · drifting UPWARD with conversation length, because the key was SET with a
 *     7-day TTL and never deleted
 *
 * Four live screens read this field. The NAME was always right and only the
 * computation was wrong, so the number changes under it rather than the field
 * being removed - removing it would break four screens and leave the wrong
 * figure in whatever place nobody has looked.
 * ════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  raw: [] as any[],
  seenSql: "",
  redis: { getdel: [] as string[], get: [] as string[] },
}));

vi.mock("@chatcenter/shared", () => ({
  prisma: {
    $queryRaw: async (q: any, ...vals: any[]) => {
      state.seenSql = Array.isArray(q?.strings) ? q.strings.join("?") : String(q?.sql ?? q);
      return state.raw;
    },
    conversation: { count: async () => 0 },
  },
  getRedis: () => ({
    hgetall: async () => ({}),
    lrange: async () => [],
    get: async (k: string) => { state.redis.get.push(k); return null; },
    getdel: async (k: string) => { state.redis.getdel.push(k); return null; },
  }),
}));

import { getAvgFirstReplyMs, getDashboardStats } from "../services/analytics.service";

beforeEach(() => {
  state.raw = [];
  state.seenSql = "";
  state.redis = { getdel: [], get: [] };
});

describe("★ the first-reply computation", () => {
  it("returns the rounded average and its sample size", async () => {
    state.raw = [{ avg_ms: 4210.7, pairs: 12n }];

    const res = await getAvgFirstReplyMs("t1", new Date("2026-09-26T00:00:00Z"));

    expect(res).toEqual({ avgMs: 4211, pairs: 12 });
  });

  it("★ is NULL, not zero, when nothing matched", async () => {
    state.raw = [{ avg_ms: null, pairs: 0n }];

    const res = await getAvgFirstReplyMs("t1", new Date());

    // "no customer wrote today" and "we replied instantly" are different facts.
    expect(res.avgMs).toBeNull();
    expect(res.pairs).toBe(0);
  });

  it("survives an empty result set", async () => {
    state.raw = [];

    await expect(getAvgFirstReplyMs("t1", new Date())).resolves.toEqual({ avgMs: null, pairs: 0 });
  });
});

describe("★ the exclusions, each of which has cost something before", () => {
  beforeEach(() => { state.raw = [{ avg_ms: 1000, pairs: 1n }]; });

  it("★ filters origin on BOTH sides - applyLiveByDefault does not reach $queryRaw", async () => {
    await getAvgFirstReplyMs("t1", new Date());

    // Imported history would otherwise contribute years-old gaps. The guard that
    // injects this for ordinary Prisma queries does not apply to raw SQL, so the
    // filter has to be written and cannot be inherited.
    const origins = state.seenSql.match(/'LIVE'::"RecordOrigin"/g) ?? [];
    expect(origins.length).toBe(2);
  });

  it("★ excludes sandbox by the PREFIX as well as isTest", async () => {
    await getAvgFirstReplyMs("t1", new Date());

    // Sandbox rows carry isTest = false, and two analytics figures have already
    // counted rehearsals as business by filtering only the flag.
    expect(state.seenSql).toContain("is_test = false");
    expect(state.seenSql).toContain("NOT LIKE 'sandbox:%'");
  });

  it("pairs each INBOUND with the earliest OUTBOUND after it", async () => {
    await getAvgFirstReplyMs("t1", new Date());

    // MIN over outbounds strictly later than the inbound, grouped per inbound -
    // the first reply, not the average of all replies.
    expect(state.seenSql).toContain("MIN(o.created_at)");
    expect(state.seenSql).toContain("o.created_at > i.created_at");
    expect(state.seenSql).toContain("GROUP BY i.id");
  });
});

describe("★ the dashboard reports it under the existing field", () => {
  it("★ avgResponseTimeMs is now the first-reply figure, with a sample size", async () => {
    state.raw = [{ avg_ms: 19000, pairs: 31n }];

    const stats: any = await getDashboardStats("t1");

    expect(stats.avgResponseTimeMs).toBe(19000);
    // So a screen can tell a real 19s from an average of one message.
    expect(stats.avgResponseSampleSize).toBe(31);
  });

  it("★ does NOT read the Redis response_times list any more", async () => {
    state.raw = [{ avg_ms: 1, pairs: 1n }];

    await getDashboardStats("t1");

    // The claim-based list is no longer the source for this number.
    expect(state.redis.get.join(" ")).not.toContain("response_times");
  });
});
