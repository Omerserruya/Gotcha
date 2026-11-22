/**
 * Out of AI units during an import (prod GOTCHA 2026-11-10): every LLM call was
 * refused with ai_units:units_exhausted, each was swallowed as "no result", and
 * the import went to COMPLETED with nothing learned and sent the "done" email.
 * Now the billing refusal stops the import: FAILED, failedStage
 * "ai-units:<stage>", no retry, no finalize (so no email), and the status view
 * reads it back as failureCode.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ updates: [] as any[], events: [] as any[], enqueued: [] as any[], stageErr: null as any }));
const { stage } = vi.hoisted(() => ({
  stage: (name: string) => ({ [name]: async () => { if (H.stageErr) throw H.stageErr; return { ok: true, done: true }; } }),
}));

vi.mock("@chatcenter/shared", () => ({
  prisma: {
    historicalImport: {
      findFirst: vi.fn(async () => ({ id: "imp1", status: "CUSTOMER_LEARNING" })),
      updateMany: vi.fn(async (a: any) => { H.updates.push(a); return { count: 1 }; }),
    },
    historicalImportEvent: { create: vi.fn(async (a: any) => { H.events.push(a.data); }) },
  },
  withHistoricalRecords: (fn: any) => fn(),
  historicalIntelligenceQueue: { add: vi.fn(async (_n: string, d: any) => { H.enqueued.push(d.stage); }) },
}));
vi.mock("../services/historical-intelligence/identity.stage", () => stage("runIdentityStage"));
vi.mock("../services/historical-intelligence/relevance.stage", () => stage("runRelevanceStage"));
vi.mock("../services/historical-intelligence/customer-learning.stage", () => stage("runCustomerLearningStage"));
vi.mock("../services/historical-intelligence/knowledge-extraction.stage", () => stage("runKnowledgeExtractionStage"));
vi.mock("../services/historical-intelligence/knowledge-clustering.stage", () => stage("runKnowledgeClusteringStage"));
vi.mock("../services/historical-intelligence/knowledge-dedupe.stage", () => stage("runKnowledgeDedupeStage"));
vi.mock("../services/historical-intelligence/knowledge-curation.stage", () => stage("runKnowledgeCurationStage"));
vi.mock("../services/historical-intelligence/brand-voice.stage", () => stage("runBrandVoiceStage"));
vi.mock("../services/historical-intelligence/analytics.stage", () => stage("runAnalyticsStage"));
vi.mock("../services/historical-intelligence/finalize.stage", () => stage("runFinalizeStage"));
vi.mock("../services/historical-intelligence/candidate-index", () => ({ dropImportClusters: vi.fn() }));

import { processHistoricalIntelligence, historicalFailureCode, aiDeniedCopy } from "../services/historical-intelligence";
import { mapLimited, isAiAccessDenied, aiDenyReason } from "../services/historical-intelligence/stage-utils";

class AiUnitsExhaustedError extends Error {
  constructor(public reason: string) { super(`ai_units:${reason}`); this.name = "AiUnitsExhaustedError"; }
}
const job = (s: string, attemptsMade = 0) => ({ data: { tenantId: "t1", importId: "imp1", stage: s }, attemptsMade, opts: { attempts: 3 } }) as any;

beforeEach(() => { H.updates = []; H.events = []; H.enqueued = []; H.stageErr = null; });

describe("the stage machine", () => {
  it("★ the contact marks run between identity and customer learning (2026-11-22)", async () => {
    await processHistoricalIntelligence(job("identity"));
    await processHistoricalIntelligence(job("relevance"));
    expect(H.enqueued).toEqual(["relevance", "customer-learning"]);
  });

  it("★ units exhausted: FAILED at once with ai-units:<stage>, the units copy, no retry, nothing enqueued", async () => {
    H.stageErr = new AiUnitsExhaustedError("units_exhausted");
    await expect(processHistoricalIntelligence(job("customer-learning"))).resolves.toBeUndefined();
    const failed = H.updates.find((u) => u.data.status === "FAILED");
    expect(failed.data).toEqual({ status: "FAILED", failedStage: "ai-units:customer-learning", failureReason: aiDeniedCopy("units_exhausted") });
    expect(failed.data.failureReason).toMatch(/ran out of AI units/);
    expect(H.enqueued).toEqual([]);
    expect(H.events.at(-1)).toMatchObject({ step: "CUSTOMER_LEARNING", outcome: "FAILED" });
  });

  it("another billing refusal (suspended) is ai-access:<stage>", async () => {
    H.stageErr = new AiUnitsExhaustedError("suspended");
    await processHistoricalIntelligence(job("knowledge-extraction"));
    expect(H.updates.find((u) => u.data.status === "FAILED").data.failedStage).toBe("ai-access:knowledge-extraction");
  });

  it("an ordinary error still throws for BullMQ to retry, and is not FAILED before the last attempt", async () => {
    H.stageErr = new Error("db blip");
    await expect(processHistoricalIntelligence(job("customer-learning"))).rejects.toThrow("db blip");
    expect(H.updates.some((u) => u.data.status === "FAILED")).toBe(false);
  });

  it("a stage that ends normally moves on (unchanged)", async () => {
    await processHistoricalIntelligence(job("customer-learning"));
    expect(H.enqueued).toEqual(["knowledge-extraction"]);
  });
});

describe("failureCode", () => {
  it("from failedStage, only on FAILED; every other failure is null", () => {
    expect(historicalFailureCode({ status: "FAILED", failedStage: "ai-units:customer-learning" })).toBe("units_exhausted");
    expect(historicalFailureCode({ status: "FAILED", failedStage: "ai-access:analytics" })).toBe("ai_access_denied");
    expect(historicalFailureCode({ status: "FAILED", failedStage: "customer-learning" })).toBeNull();
    expect(historicalFailureCode({ status: "FAILED", failedStage: "source-sync" })).toBeNull();
    expect(historicalFailureCode({ status: "COMPLETED", failedStage: null })).toBeNull();
  });
});

describe("mapLimited", () => {
  it("★ stops taking items after a units refusal and rethrows it", async () => {
    const seen: number[] = [];
    const err = new AiUnitsExhaustedError("units_exhausted");
    await expect(mapLimited([1, 2, 3, 4, 5, 6], 1, async (n) => { seen.push(n); if (n === 2) throw err; return n; })).rejects.toBe(err);
    expect(seen).toEqual([1, 2]);
  });
  it("any other item error is still a gap, not a stop", async () => {
    const out = await mapLimited([1, 2, 3], 2, async (n) => { if (n === 2) throw new Error("bad"); return n; });
    expect(out).toEqual([1, null, 3]);
  });
  it("recognises the refusal by name or by its ai_units: message", () => {
    expect(isAiAccessDenied(new AiUnitsExhaustedError("units_exhausted"))).toBe(true);
    expect(isAiAccessDenied(new Error("ai_units:units_exhausted"))).toBe(true);
    expect(isAiAccessDenied(new Error("429 rate limit"))).toBe(false);
    expect(aiDenyReason(new AiUnitsExhaustedError("credits_exhausted"))).toBe("units_exhausted");
    expect(aiDenyReason(new Error("ai_units:trial_expired"))).toBe("trial_expired");
  });
});
