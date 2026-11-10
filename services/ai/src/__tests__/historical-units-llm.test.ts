/**
 * structuredCall inside an import rethrows the billing refusal (the import
 * stops); outside an import (live voice) it stays "no result". And customer
 * learning keeps customersTotal on the same rows as customersAnalyzed, so the
 * counter cannot read "310 of 279" (prod GOTCHA 2026-11-10: history chunks
 * arrived after the identity stage had counted).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ err: null as any, rows: [] as any[], importUpdate: null as any }));

vi.mock("../services/ai.service", () => ({
  generateResponse: vi.fn(async () => { if (H.err) throw H.err; return { content: '{"facts":[]}' }; }),
  callWithRetry: (fn: any) => fn(),
  getDefaultModel: () => "m",
  getMicroModel: () => "m",
}));
const matches = (r: any, w: any) => Object.entries(w).every(([k, v]: any) => (v && typeof v === "object" && "not" in v ? r[k] !== v.not : r[k] === v));
vi.mock("@chatcenter/shared", () => ({
  prisma: {
    tenant: { findUnique: async () => ({ defaultLocale: "he" }) },
    historicalCustomer: {
      findMany: async (a: any) => H.rows.filter((r) => matches(r, a.where)).slice(0, a.take ?? 1e9),
      update: async (a: any) => Object.assign(H.rows.find((r) => r.id === a.where.id), a.data),
      count: async (a: any) => H.rows.filter((r) => matches(r, a.where)).length,
    },
    historicalImport: { update: async (a: any) => { H.importUpdate = a.data; } },
    historicalImportEvent: { create: async () => ({}) },
  },
  withHistoricalRecords: (fn: any) => fn(),
}));

vi.mock("../services/historical-intelligence/stage-utils", async (orig) => ({
  ...(await orig<any>()),
  loadConversationTranscript: async () => [{ direction: "INBOUND", content: "hi" }],
  renderTranscript: () => "Customer: hi",
}));

import { z } from "zod";
import { structuredCall } from "../services/historical-intelligence/llm";
import { runCustomerLearningStage } from "../services/historical-intelligence/customer-learning.stage";

class AiUnitsExhaustedError extends Error {
  constructor(public reason: string) { super(`ai_units:${reason}`); this.name = "AiUnitsExhaustedError"; }
}
const args = { tenantId: "t1", schema: z.object({ facts: z.array(z.string()) }), system: "s", user: "u", feature: "f" };

beforeEach(() => { H.err = null; H.rows = []; H.importUpdate = null; });

describe("structuredCall", () => {
  it("★ in an import: the units refusal is thrown", async () => {
    H.err = new AiUnitsExhaustedError("units_exhausted");
    await expect(structuredCall({ ...args, importId: "imp1" })).rejects.toThrow("ai_units:units_exhausted");
  });
  it("outside an import: still null; a provider error is still null", async () => {
    H.err = new AiUnitsExhaustedError("units_exhausted");
    expect(await structuredCall(args)).toBeNull();
    H.err = new Error("503");
    expect(await structuredCall({ ...args, importId: "imp1" })).toBeNull();
  });
});

describe("customer learning counters", () => {
  it("★ customersTotal is recounted from the rows with customersAnalyzed", async () => {
    // 3 rows the identity stage never saw; all too short to learn from.
    H.rows = [1, 2, 3].map((i) => ({ id: `c${i}`, importId: "imp1", tenantId: "t1", learningStatus: "PENDING", conversationId: "cv", inboundCount: 1, messageCount: 1 }));
    await runCustomerLearningStage({ tenantId: "t1", importId: "imp1" });
    expect(H.importUpdate).toEqual({ customersAnalyzed: 3, customersTotal: 3 });
  });
  it("★ a units refusal stops the stage; the refused customer stays PENDING for the rerun", async () => {
    H.rows = [{ id: "c1", importId: "imp1", tenantId: "t1", learningStatus: "PENDING", conversationId: "cv", inboundCount: 5, messageCount: 5 }];
    H.err = new AiUnitsExhaustedError("units_exhausted");
    await expect(runCustomerLearningStage({ tenantId: "t1", importId: "imp1" })).rejects.toThrow("ai_units:units_exhausted");
    expect(H.rows[0].learningStatus).toBe("PENDING");
    expect(H.importUpdate).toBeNull();
  });
});
