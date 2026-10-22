/**
 * Per-fact provenance on GET /api/historical-imports/customer-context.
 *
 * The projection dropped `evidenceConversationIds` for every fact, and the
 * field appears nowhere else in any route - so a screen asking "where was this
 * learned?" had no way to discover the answer existed. The writer stamps it on
 * every fact (customer-learning.stage.ts:205-227); only the read threw it away.
 *
 * ★ THE TWO TIMESTAMPS ARE THE TRANSCRIPT'S SPAN, NOT EACH FACT'S. Both are
 * taken from the first and last message of the whole conversation, so every
 * fact in a row carries identical values. Returned per fact they would invite
 * "this preference was first seen on the 3rd" - a claim the data cannot
 * support. They are reported once, as `evidenceWindow`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const state = vi.hoisted(() => ({ memory: null as any }));

// Exhaustive by necessity: this barrel is mocked wholesale, and a symbol the
// router imports but the mock omits is `undefined` at module scope - which
// throws during collection and reports as "no tests" rather than a failure.
vi.mock("@chatcenter/shared", () => ({
  prisma: {
    customerHistoricalMemory: { findFirst: async () => state.memory },
    // Present only so the shadowing test can prove WHICH handler answered:
    // `/:id` reads this one, `/customer-context` never touches it.
    historicalImport: { findFirst: async () => null },
    // No private numbers here (the private-number reads have their own test).
    inboundExclusion: { findMany: async () => [] },
  },
  normalizePhone: (p: string) => p.replace(/[^\d+]/g, ""),
  normalizeExclusionValue: (raw: string) => (raw || "").replace(/\D/g, ""),
  authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1" }; n(); },
  resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "t1"; n(); },
  requireOnboardingOrActiveTenant: () => (_q: any, _s: any, n: any) => n(),
  requirePermissionOrRole: () => (_q: any, _s: any, n: any) => n(),
  withHistoricalRecords: (fn: any) => fn(),
  historicalImportStage: () => "DONE",
  historicalImportPercent: () => 100,
  historicalAnalysisPercent: () => 100,
  historicalAnalysisCounts: () => ({ analyzed: 0, total: 0 }),
  hasHistoricalResults: () => false,
  HISTORICAL_SOURCE_WINDOW_DAYS: 90,
  writeAudit: async () => undefined,
  AuditAction: {},
}));

// Pulled in at module scope by the router; none of it runs on this read path.
vi.mock("../services/embedding.service", () => ({ processDocument: async () => undefined }));
vi.mock("../services/historical-intelligence/candidate-index", () => ({ findExistingKnowledge: async () => [] }));
vi.mock("../services/historical-intelligence/knowledge-clustering.stage", () => ({ BULK_APPROVE_MIN_CONFIDENCE: 0.8 }));
vi.mock("../services/historical-intelligence", () => ({ rerunIntelligence: async () => undefined }));

import historicalImportRouter from "../routes/historical-import";

const app = express();
app.use(express.json());
app.use("/api/historical-imports", historicalImportRouter);

/** Two facts from ONE transcript, which is why the timestamps are equal. */
const MEMORY = {
  summary: "Regular buyer, prefers evening delivery.",
  messageCount: 412,
  source: "historical_whatsapp_import",
  updatedAt: new Date("2026-09-14T10:00:00.000Z"),
  importId: "imp_1",
  facts: [
    {
      text: "Prefers deliveries after 6pm",
      category: "preference",
      confidence: "high",
      evidenceConversationIds: ["conv_abc"],
      firstSeenAt: "2024-03-02T08:00:00.000Z",
      lastSeenAt: "2026-09-01T17:30:00.000Z",
    },
    {
      text: "Has two dogs",
      category: "context",
      confidence: "medium",
      evidenceConversationIds: ["conv_abc"],
      firstSeenAt: "2024-03-02T08:00:00.000Z",
      lastSeenAt: "2026-09-01T17:30:00.000Z",
    },
  ],
};

beforeEach(() => { state.memory = structuredClone(MEMORY); });

const get = () => request(app).get("/api/historical-imports/customer-context").query({ externalId: "+972501234567" });

describe("a fact carries where it was learned", () => {
  it("★ returns evidenceConversationIds per fact", async () => {
    const res = await get();

    expect(res.status).toBe(200);
    // The whole point: the screen can link this one to that conversation.
    expect(res.body.context.facts[0].evidenceConversationIds).toEqual(["conv_abc"]);
    expect(res.body.context.facts[1].evidenceConversationIds).toEqual(["conv_abc"]);
  });

  it("keeps the three fields the projection already had", async () => {
    const res = await get();

    expect(res.body.context.facts[0]).toMatchObject({
      text: "Prefers deliveries after 6pm",
      category: "preference",
      confidence: "high",
    });
    expect(res.body.context.messageCount).toBe(412);
    expect(res.body.context.source).toBe("historical_whatsapp_import");
  });

  it("gives an empty array, never undefined, when a fact has no evidence", async () => {
    state.memory.facts = [{ text: "Bare fact", category: null, confidence: null }];

    const res = await get();

    // A missing key would make a consumer print "undefined" or crash on .length;
    // an empty array says "this fact has no recorded evidence" in the same shape.
    expect(res.body.context.facts[0].evidenceConversationIds).toEqual([]);
  });

  it("drops a non-string id rather than passing it through", async () => {
    state.memory.facts[0].evidenceConversationIds = ["conv_ok", null, 42, ""];

    const res = await get();

    expect(res.body.context.facts[0].evidenceConversationIds).toEqual(["conv_ok"]);
  });
});

describe("the evidence window is stated once, not per fact", () => {
  it("★ reports the transcript span at the block level", async () => {
    const res = await get();

    expect(res.body.context.evidenceWindow).toEqual({
      from: "2024-03-02T08:00:00.000Z",
      to: "2026-09-01T17:30:00.000Z",
    });
  });

  it("★ does NOT put firstSeenAt/lastSeenAt on a fact", async () => {
    const res = await get();

    // Per fact they read as "this preference was first observed then", which is
    // false: they are the conversation's first and last message for EVERY fact.
    for (const fact of res.body.context.facts) {
      expect(fact.firstSeenAt).toBeUndefined();
      expect(fact.lastSeenAt).toBeUndefined();
    }
  });

  it("is null when no fact carries a timestamp", async () => {
    state.memory.facts = [{ text: "Bare fact" }];

    const res = await get();

    // Not a window of nulls, and not today's date standing in for unknown.
    expect(res.body.context.evidenceWindow).toBeNull();
  });

  it("survives a half-populated window", async () => {
    state.memory.facts = [{ text: "One-sided", firstSeenAt: "2024-03-02T08:00:00.000Z" }];

    const res = await get();

    expect(res.body.context.evidenceWindow).toEqual({ from: "2024-03-02T08:00:00.000Z", to: null });
  });
});

describe("the endpoint still fails soft", () => {
  it("answers context: null for a customer with no memory", async () => {
    state.memory = null;

    const res = await get();

    expect(res.status).toBe(200);
    expect(res.body.context).toBeNull();
  });

  it("answers context: null for a missing externalId", async () => {
    const res = await request(app).get("/api/historical-imports/customer-context");

    expect(res.status).toBe(200);
    expect(res.body.context).toBeNull();
  });
});

/**
 * ★ THE ROUTE WAS UNREACHABLE, AND THAT IS WHY THIS FILE EXISTS.
 *
 * `router.get("/customer-context")` was declared ~450 lines BELOW
 * `router.get("/:id")`. Express matches in declaration order and `/:id` takes
 * one segment, so every request went to the import lookup, which found no
 * import called "customer-context" and answered 404 "Import not found".
 *
 * A 404 from an enhancement endpoint is indistinguishable from "this customer
 * has no history", so nothing ever reported it.
 */
describe("the route is reachable at all", () => {
  it("★ is NOT answered by the /:id import lookup", async () => {
    const res = await get();

    expect(res.status).toBe(200);
    // The tell: /:id answers this exact body for an id it cannot find.
    expect(res.body.error).not.toBe("Import not found");
    expect(res.body).toHaveProperty("context");
  });

  it("still routes a real import id to /:id", async () => {
    // Moving the literal path must not shadow the parameterised one.
    const res = await request(app).get("/api/historical-imports/imp_123");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Import not found");
  });
});
