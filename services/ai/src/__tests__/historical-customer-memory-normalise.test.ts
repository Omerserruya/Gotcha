/**
 * Customer memory is normalised, not dropped (prod Smoovee 2026-11-13): a reply
 * with an off-list category ("fulfillment_preference") or more than 8 facts
 * used to fail the schema twice and leave the customer with NO memory at all.
 * Now the category is filed under "other" and the list is cut to 8, most
 * confident first, on the first reply. A fact that is really broken (an
 * off-list confidence) still fails the schema, so the gate is still there.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ replies: [] as string[], calls: 0, system: "", rows: [] as any[], upserts: [] as any[] }));

vi.mock("../services/ai.service", () => ({
  generateResponse: vi.fn(async (a: any) => { H.calls += 1; H.system = a.messages[0].content; return { content: H.replies.shift() ?? '{"facts":[]}' }; }),
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
    customerHistoricalMemory: { upsert: async (a: any) => { H.upserts.push(a); return {}; } },
    historicalImport: { update: async () => ({}) },
    historicalImportEvent: { create: async () => ({}) },
  },
  withHistoricalRecords: (fn: any) => fn(),
}));
vi.mock("../services/historical-intelligence/stage-utils", async (orig) => ({
  ...(await orig<any>()),
  loadConversationTranscript: async () => [{ direction: "INBOUND", content: "hi", at: new Date("2026-01-01") }],
  renderTranscript: () => "Customer: hi",
}));

import {
  CustomerMemorySchema,
  MAX_FACTS,
  runCustomerLearningStage,
} from "../services/historical-intelligence/customer-learning.stage";

const fact = (n: number, confidence = "medium", category = "purchase_history") => ({ text: `fact number ${n}`, category, confidence });

beforeEach(() => {
  H.replies = []; H.calls = 0; H.upserts = [];
  H.rows = [{ id: "c1", importId: "imp1", tenantId: "t1", learningStatus: "PENDING", conversationId: "cv1", inboundCount: 5, messageCount: 9, normalizedPhone: "972500000000" }];
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("the schema normalises", () => {
  it("an off-list or missing category becomes 'other'; listed ones stay", () => {
    const r = CustomerMemorySchema.parse({ facts: [fact(1, "high", "fulfillment_preference"), { text: "no category", confidence: "low" }, fact(3, "high", "service_issue")] });
    expect(r.facts.map((f) => f.category)).toEqual(["other", "other", "service_issue"]);
  });

  it("more than 8 facts: cut to 8, most confident first, the model's order breaking ties", () => {
    // 12 facts: lows at 0-3, mediums at 4-7, highs at 8-11.
    const facts = [0, 1, 2, 3].map((i) => fact(i, "low")).concat([4, 5, 6, 7].map((i) => fact(i, "medium")), [8, 9, 10, 11].map((i) => fact(i, "high")));
    const r = CustomerMemorySchema.parse({ facts });
    expect(MAX_FACTS).toBe(8);
    expect(r.facts.map((f) => f.text)).toEqual([8, 9, 10, 11, 4, 5, 6, 7].map((i) => `fact number ${i}`));
  });

  it("exactly 8 facts keep the model's order", () => {
    const facts = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => fact(i, i % 2 ? "high" : "low"));
    expect(CustomerMemorySchema.parse({ facts }).facts.map((f) => f.text)).toEqual(facts.map((f) => f.text));
  });

  it("a really broken fact still fails: an off-list confidence, a too-long text, facts not an array", () => {
    expect(CustomerMemorySchema.safeParse({ facts: [fact(1, "certain")] }).success).toBe(false);
    expect(CustomerMemorySchema.safeParse({ facts: [{ ...fact(1), text: "x".repeat(241) }] }).success).toBe(false);
    expect(CustomerMemorySchema.safeParse({ facts: "lots" }).success).toBe(false);
  });
});

describe("the stage keeps the customer's memory", () => {
  it("★ Smoovee's reply (11 facts, one 'fulfillment_preference'): DONE on the first call, 8 facts stored", async () => {
    const facts = Array.from({ length: 11 }, (_, i) => fact(i, i < 3 ? "low" : "high", i === 4 ? "fulfillment_preference" : "purchase_history"));
    H.replies = [JSON.stringify({ facts, summary: "Buys often." })];
    await runCustomerLearningStage({ tenantId: "t1", importId: "imp1" });
    expect(H.calls).toBe(1);
    expect(H.rows[0].learningStatus).toBe("DONE");
    const stored = H.upserts[0].create.facts;
    expect(stored).toHaveLength(8);
    expect(stored.map((f: any) => f.text)).toEqual([3, 4, 5, 6, 7, 8, 9, 10].map((i) => `fact number ${i}`));
    expect(stored.find((f: any) => f.text === "fact number 4").category).toBe("other");
    expect(H.upserts[0].create.summary).toBe("Buys often.");
  });

  it("control: an off-list confidence twice is still FAILED with no memory written", async () => {
    H.replies = [JSON.stringify({ facts: [fact(1, "certain")] }), JSON.stringify({ facts: [fact(1, "certain")] })];
    await runCustomerLearningStage({ tenantId: "t1", importId: "imp1" });
    expect(H.calls).toBe(2);
    expect(H.rows[0].learningStatus).toBe("FAILED");
    expect(H.upserts).toHaveLength(0);
  });

  it("the prompt tells the model the limit and every category", async () => {
    await runCustomerLearningStage({ tenantId: "t1", importId: "imp1" });
    expect(H.system).toContain("At most 8 facts");
    expect(H.system).toContain("purchase_history, product_preference, service_issue, delivery_preference, communication_pattern, other.");
  });
});
