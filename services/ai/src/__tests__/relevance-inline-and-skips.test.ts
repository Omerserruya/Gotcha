/**
 * Hidden conversations get no automation (2026-11-22), the ai side:
 *   - POST /api/internal/relevance/classify: the label NOW, for the incoming-worker's first-inbound wait;
 *   - the 2-minute job refines a model label made inline, once;
 *   - live extraction, copilot suggestions, the post-chat pipeline and the close analysis skip a hidden one.
 * No model is called: the classifier is a double.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ hidden: false, hiddenCalls: [] as any[], job: null as any }));

vi.mock("../services/ai.service", () => ({ generateResponse: vi.fn(), getDefaultModel: () => "m", getMicroModel: () => "m", platformPaidScope: { run: (_: any, f: any) => f() } }));
vi.mock("@chatcenter/shared/src/lib/relevance-hidden", async (orig) => ({
  ...(await orig<any>()),
  isConversationHidden: vi.fn(async (...a: any[]) => { H.hiddenCalls.push(a); return H.hidden; }),
  logHiddenSkip: vi.fn(),
}));

import { shouldRefine, REFINE_BELOW, processRelevanceJob } from "../workers/relevance/worker";

const now = new Date("2026-11-22T18:00:00Z");
const minAgo = (m: number) => new Date(now.getTime() - m * 60_000);
const conv = (o: any = {}) => ({ id: "c1", tenantId: "t1", channel: "WHATSAPP", customerExternalId: "972500", relevanceCategory: "personal", relevanceConfidence: 0.8, relevanceSource: "model", relevanceClassifiedAt: minAgo(2), relevanceOverriddenBy: null, ...o });
const inbound = (m: number) => ({ direction: "INBOUND", body: "hi", createdAt: minAgo(m) });
const db = (c: any, history = [inbound(3)]) => ({
  conversation: { findFirst: async () => c },
  message: { findMany: async () => [...history].reverse(), findFirst: async () => ({ direction: "INBOUND" }) },
  user: { findMany: async () => [] },
});
const label = (category: string, confidence: number) => ({ category, confidence, reason: "r", source: "model", classifiedAt: now.toISOString() });

describe("refining the inline label once", () => {
  it("shouldRefine: only a model label, not a person's, when unsure (under 0.9) or the customer wrote again since", () => {
    expect(REFINE_BELOW).toBe(0.9);
    expect(shouldRefine(conv(), [inbound(3)])).toBe(true);
    expect(shouldRefine(conv({ relevanceConfidence: 0.95 }), [inbound(3)])).toBe(false);
    expect(shouldRefine(conv({ relevanceConfidence: 0.95 }), [inbound(3), inbound(1)])).toBe(true);
    expect(shouldRefine(conv({ relevanceSource: "fast" }), [inbound(1)])).toBe(false);
    expect(shouldRefine(conv({ relevanceSource: "sender" }), [inbound(1)])).toBe(false);
    expect(shouldRefine(conv({ relevanceOverriddenBy: "u1" }), [inbound(1)])).toBe(false);
    expect(shouldRefine(conv({ relevanceClassifiedAt: null }), [inbound(1)])).toBe(false);
  });

  it("the job enqueued with refine classifies again; without refine the same stored label is kept", async () => {
    process.env.RELEVANCE_CLASSIFY_TENANTS = "t1";
    const classify = vi.fn(async () => label("business", 0.93));
    const write = vi.fn(async () => undefined);
    const deps = { classify: classify as any, write, company: async () => null as any, now: () => now };
    const fresh = await processRelevanceJob({ tenantId: "t1", conversationId: "c1", refine: true }, { ...deps, db: db(conv()) });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(fresh).toMatchObject({ source: "model", category: "business" });
    expect(write).toHaveBeenCalledTimes(1);
    const kept = await processRelevanceJob({ tenantId: "t1", conversationId: "c1" }, { ...deps, db: db(conv()) });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(kept).toMatchObject({ source: "stored", category: "personal" });
  });

  it("refine never touches a person's mark, nor a confident rule label", async () => {
    process.env.RELEVANCE_CLASSIFY_TENANTS = "t1";
    const classify = vi.fn(async () => label("business", 0.93));
    const deps = { classify: classify as any, write: vi.fn(async () => undefined), company: async () => null as any, now: () => now };
    expect(await processRelevanceJob({ tenantId: "t1", conversationId: "c1", refine: true }, { ...deps, db: db(conv({ relevanceOverriddenBy: "u1" })) })).toMatchObject({ source: "override" });
    expect(await processRelevanceJob({ tenantId: "t1", conversationId: "c1", refine: true }, { ...deps, db: db(conv({ relevanceSource: "fast", relevanceConfidence: 0.95 })) })).toMatchObject({ source: "stored" });
    expect(classify).not.toHaveBeenCalled();
  });
});

describe("POST /api/internal/relevance/classify", () => {
  const app = async (job: any) => {
    vi.resetModules();
    vi.doMock("../workers/relevance/worker", () => ({ processRelevanceJob: vi.fn(async (j: any, d: any) => { H.job = { j, d }; return job(); }) }));
    vi.doMock("@chatcenter/shared", async (orig) => ({ ...(await orig<any>()), requireInternalKey: (req: any, res: any, next: any) => (req.headers["x-internal-key"] === "k" ? next() : res.status(401).json({ error: "no" })) }));
    const { default: router, INLINE_CLASSIFY_TIMEOUT_MS } = await import("../routes/internal-relevance");
    const a = express();
    a.use(express.json());
    a.use("/api", router);
    return { a, INLINE_CLASSIFY_TIMEOUT_MS };
  };

  it("answers the label, with its own timeout under the worker's 3 s", async () => {
    const { a, INLINE_CLASSIFY_TIMEOUT_MS } = await app(() => ({ mode: "shadow", category: "personal", confidence: 0.88, source: "model", hold: true }));
    expect(INLINE_CLASSIFY_TIMEOUT_MS).toBeLessThan(3000);
    const r = await request(a).post("/api/internal/relevance/classify").set("X-Internal-Key", "k").send({ tenantId: "t1", conversationId: "c1" });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ category: "personal", confidence: 0.88, source: "model" });
    expect(H.job.j).toEqual({ tenantId: "t1", conversationId: "c1" });
    expect(H.job.d).toEqual({ timeoutMs: INLINE_CLASSIFY_TIMEOUT_MS });
  });

  it("internal only, both ids required, and a failure is a no-label answer, never a 500", async () => {
    const { a } = await app(() => { throw new Error("boom"); });
    expect((await request(a).post("/api/internal/relevance/classify").send({ tenantId: "t1", conversationId: "c1" })).status).toBe(401);
    expect((await request(a).post("/api/internal/relevance/classify").set("X-Internal-Key", "k").send({ tenantId: "t1" })).status).toBe(400);
    const r = await request(a).post("/api/internal/relevance/classify").set("X-Internal-Key", "k").send({ tenantId: "t1", conversationId: "c1" });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ category: null, source: "error" });
  });
});
