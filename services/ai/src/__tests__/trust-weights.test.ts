import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../services/intelligence/trust/cue-outcomes.repo", () => ({
  aggregateAll: vi.fn(),
}));

import { trustWeights } from "../services/intelligence/trust/trust-weights.service";
import { aggregateAll } from "../services/intelligence/trust/cue-outcomes.repo";

const mockAggregate = aggregateAll as unknown as ReturnType<typeof vi.fn>;

describe("trustWeights", () => {
  beforeEach(() => {
    trustWeights._resetForTest();
    mockAggregate.mockReset();
  });

  it("returns neutral 0.5 for an unknown cue", () => {
    mockAggregate.mockResolvedValueOnce([]);
    expect(trustWeights.weightFor("missing_field", "ask email")).toBe(0.5);
  });

  it("applies Laplace smoothing - perfect accepts still < 1.0", async () => {
    mockAggregate.mockResolvedValueOnce([
      { cueKind: "missing_field", cueText: "ask email", accepts: 10, rejects: 0, ignores: 0 },
    ]);
    await trustWeights.refresh();
    const w = trustWeights.weightFor("missing_field", "ask email");
    // (10+1) / (10+0+0+1+1) = 11/12 ≈ 0.917
    expect(w).toBeGreaterThan(0.9);
    expect(w).toBeLessThan(1.0);
  });

  it("penalizes rejected cues", async () => {
    mockAggregate.mockResolvedValueOnce([
      { cueKind: "suggested_action", cueText: "small talk", accepts: 0, rejects: 10, ignores: 0 },
    ]);
    await trustWeights.refresh();
    const w = trustWeights.weightFor("suggested_action", "small talk");
    // 1 / (0+10+0+1+1) = 1/12 ≈ 0.083
    expect(w).toBeLessThan(0.1);
  });

  it("counts ignores as half-negative", async () => {
    mockAggregate.mockResolvedValueOnce([
      { cueKind: "risk", cueText: "tone shift", accepts: 1, rejects: 0, ignores: 4 },
    ]);
    await trustWeights.refresh();
    const w = trustWeights.weightFor("risk", "tone shift");
    // (1+1) / (1+0+4*0.5+1+1) = 2/5 = 0.4
    expect(w).toBeCloseTo(0.4, 2);
  });

  it("dedupes inflight refreshes", async () => {
    mockAggregate.mockResolvedValueOnce([]);
    const a = trustWeights.refresh();
    const b = trustWeights.refresh();
    expect(a).toBe(b);
    await a;
    expect(mockAggregate).toHaveBeenCalledTimes(1);
  });
});
