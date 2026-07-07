/**
 * P1-6 — per-employee usage rollup. Groups usage rows by aiAgentId; computes
 * cost/tokens/turns/latency/cache-hit from the denormalized columns.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("../prisma", () => ({ prisma: { usageLog: { findMany: h.findMany } } }));

import { getEmployeeUsageRollup } from "../ai-usage";

beforeEach(() => h.findMany.mockReset());

describe("getEmployeeUsageRollup", () => {
  it("groups by aiAgentId, sums cost/tokens, counts distinct turns, averages latency, computes cache-hit", async () => {
    h.findMany.mockResolvedValue([
      { aiAgentId: "a1", promptTokens: 1000, completionTokens: 100, tokensEquivalent: 1100, costUsd: "0.005", turnId: "t1", durationMs: 800, metadata: { cachedPromptTokens: 500 } },
      { aiAgentId: "a1", promptTokens: 200, completionTokens: 50, tokensEquivalent: 250, costUsd: "0.001", turnId: "t1", durationMs: 400, metadata: {} },
      { aiAgentId: "a1", promptTokens: 300, completionTokens: 60, tokensEquivalent: 360, costUsd: "0.002", turnId: "t2", durationMs: 600, metadata: {} },
      { aiAgentId: "a2", promptTokens: 100, completionTokens: 10, tokensEquivalent: 110, costUsd: "0.0005", turnId: "t3", durationMs: 200, metadata: {} },
    ]);
    const out = await getEmployeeUsageRollup("t1");
    expect(out.length).toBe(2);
    const a1 = out.find((r) => r.aiAgentId === "a1")!;
    expect(a1.calls).toBe(3);
    expect(a1.promptTokens).toBe(1500);
    expect(a1.completionTokens).toBe(210);
    expect(a1.totalTokens).toBe(1710);
    expect(a1.costUsd).toBeCloseTo(0.008, 6);
    expect(a1.turns).toBe(2); // t1, t2 distinct
    expect(a1.avgDurationMs).toBe(600); // (800+400+600)/3
    expect(a1.cacheHitRate).toBeCloseTo(500 / 1500, 4);
    // Sorted by cost desc → a1 first.
    expect(out[0].aiAgentId).toBe("a1");
  });

  it("cacheHitRate null when no prompt tokens; avgDurationMs null when no durations", async () => {
    h.findMany.mockResolvedValue([
      { aiAgentId: "a1", promptTokens: 0, completionTokens: 0, tokensEquivalent: 0, costUsd: "0", turnId: null, durationMs: null, metadata: {} },
    ]);
    const out = await getEmployeeUsageRollup("t1");
    expect(out[0].cacheHitRate).toBeNull();
    expect(out[0].avgDurationMs).toBeNull();
    expect(out[0].turns).toBe(0);
  });
});
