import { describe, it, expect } from "vitest";
import { decideMerge, type FactSnapshotEntry } from "../services/intelligence-ingest.service";

const T = 0.7; // threshold

function entry(value: unknown, confidence: number, source: FactSnapshotEntry["source"] = "llm_live", observedAt = "2026-06-17T00:00:00.000Z"): FactSnapshotEntry {
  return { value, confidence, source, observedAt, conversationId: "c1", evidence: null };
}

describe("decideMerge - Customer Intelligence conflict resolution", () => {
  it("first confident value → apply", () => {
    expect(decideMerge(undefined, entry("Healthcare", 0.9), T)).toMatchObject({ action: "apply" });
  });

  it("low-confidence first value → review (low_confidence)", () => {
    expect(decideMerge(undefined, entry("Healthcare", 0.5), T)).toMatchObject({ action: "review", reason: "low_confidence" });
  });

  it("same value, higher confidence → apply (refresh)", () => {
    const cur = entry("Healthcare", 0.8);
    expect(decideMerge(cur, entry("Healthcare", 0.95), T)).toMatchObject({ action: "apply" });
  });

  it("different value, clearly more confident → overwrite", () => {
    const cur = entry(10, 0.7);
    expect(decideMerge(cur, entry(200, 0.9), T)).toMatchObject({ action: "apply" }); // 0.9 ≥ 0.7 + 0.15
  });

  it("different value, NOT clearly more confident → review (conflict)", () => {
    const cur = entry(10, 0.8);
    expect(decideMerge(cur, entry(200, 0.85), T)).toMatchObject({ action: "review", reason: "conflict" });
  });

  it("manual current value is never overwritten by AI", () => {
    const cur = entry(10, 1, "manual");
    expect(decideMerge(cur, entry(200, 0.99), T)).toMatchObject({ action: "ignore" });
  });

  it("manual incoming value always wins (even low confidence)", () => {
    const cur = entry(10, 0.95);
    expect(decideMerge(cur, entry(200, 0.1, "manual"), T)).toMatchObject({ action: "apply" });
  });

  it("respects a per-field threshold (strict field rejects a 0.8 value)", () => {
    expect(decideMerge(undefined, entry("Healthcare", 0.8), 0.85)).toMatchObject({ action: "review", reason: "low_confidence" });
  });
});
