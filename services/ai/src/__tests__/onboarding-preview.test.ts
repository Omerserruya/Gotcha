/**
 * Onboarding 00h preview, through the real router:
 *   - ★ grounded with sources (only the excerpts the answer used)
 *   - ★ not grounded → the honest "not learned yet", and NO model call
 *   - ★ nothing becomes business state (the double has no write methods for
 *     conversation / message / unanswered / persona / skill run - any write
 *     throws), retrieval never records a gap, but an audit row IS written
 *   - an AGENT gets 403, a suspended workspace 403, 20 a minute then 429,
 *     question length 422, a billing refusal 402
 *   - the questions: real first (max 3), then found policies by confidence,
 *     then ONE customer-facing gap; found:false skipped; he/en; no wide dash
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const H = vi.hoisted(() => ({
  role: "ADMIN",
  status: "PENDING_ONBOARDING",
  chunks: [] as any[],
  retrievalOpts: [] as any[],
  model: { content: "", calls: 0, messages: [] as any[] },
  audits: [] as any[],
  redis: new Map<string, number>(),
  unanswered: [] as any[],
  discovery: null as any,
  billingDeny: null as string | null,
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: H.role }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireRole: (...roles: string[]) => (req: any, res: any, n: any) => (roles.includes(req.user.role) ? n() : res.status(403).json({ error: "Forbidden" })),
    writeAudit: async (e: any) => { H.audits.push(e); },
    getRedis: () => ({
      incr: async (k: string) => { const v = (H.redis.get(k) ?? 0) + 1; H.redis.set(k, v); return v; },
      expire: async () => 1,
    }),
    // Reads only. A write to any business table would be "not a function".
    prisma: {
      tenant: { findUnique: async () => ({ status: H.status }) },
      unansweredQuestion: { findMany: async (a: any) => H.unanswered.filter((q) => q.tenantId === a.where.tenantId && q.resolvedAt == null).slice(0, a.take).map(({ id, question, askCount }) => ({ id, question, askCount })) },
      businessDiscovery: { findUnique: async () => H.discovery },
      businessProfile: { findUnique: async () => ({ observedVoice: "Warm and short" }) },
      knowledgeDocument: {
        findMany: async (a: any) => [
          { id: "doc_ship", title: "Shipping policy", sourceUrl: "https://shop.test/shipping", knowledgeBase: { name: "Company Knowledge" } },
          { id: "doc_ret", title: "Returns", sourceUrl: null, knowledgeBase: { name: "Company Knowledge" } },
        ].filter((d) => a.where.id.in.includes(d.id) && a.where.tenantId === "T"),
      },
    },
  };
});
vi.mock("../services/knowledge.service", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    retrieveRelevantChunks: async (_t: string, _q: string, _l: number, _a: any, opts: any) => { H.retrievalOpts.push(opts); return H.chunks; },
  };
});
vi.mock("../services/ai.service", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    getDefaultModel: () => "test-model",
    generateResponse: async (p: any) => {
      H.model.calls++;
      H.model.messages = p.messages;
      if (H.billingDeny) { const e: any = new Error("ai_units"); e.name = "AiUnitsExhaustedError"; e.reason = H.billingDeny; throw e; }
      return { content: H.model.content, usage: { input_tokens: 120, output_tokens: 40, total_tokens: 160 } };
    },
  };
});

import router from "../routes/ai-assist";
import { suggestedQuestions } from "../services/onboarding-preview.service";

const app = express();
app.use(express.json());
app.use("/api/ai-assist", router);
const ask = (question: string, extra: any = {}) => request(app).post("/api/ai-assist/onboarding-preview-answer").send({ question, ...extra });

beforeEach(() => {
  H.role = "ADMIN"; H.status = "PENDING_ONBOARDING"; H.chunks = []; H.retrievalOpts = []; H.model = { content: "", calls: 0, messages: [] };
  H.audits = []; H.redis = new Map(); H.unanswered = []; H.discovery = null; H.billingDeny = null;
});

describe("★ POST onboarding-preview-answer", () => {
  it("grounded: answers from Knowledge with only the sources it used", async () => {
    H.chunks = [
      { content: "We ship in 3 business days — free over 200.", score: 0.82, documentTitle: "Shipping policy", documentId: "doc_ship" },
      { content: "Returns within 14 days.", score: 0.6, documentTitle: "Returns", documentId: "doc_ret" },
    ];
    H.model.content = JSON.stringify({ answer: "We ship in 3 business days — free over 200.", covered: true, used: [1] });
    const r = await ask("How long does shipping take?");
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({
      answer: "We ship in 3 business days - free over 200.",
      grounded: true,
      sources: [{ documentId: "doc_ship", title: "Shipping policy", sourceUrl: "https://shop.test/shipping", path: "Company Knowledge / Shipping policy" }],
    });
  });

  it("★ not grounded: nothing relevant in Knowledge → honest answer, no model call, no sources", async () => {
    H.chunks = [{ content: "unrelated", score: 0.1, documentTitle: "x", documentId: "doc_ship" }];
    const r = await ask("Do you sell gift cards in Jerusalem?", { locale: "he" });
    expect(r.body.data).toMatchObject({ grounded: false, sources: [] });
    expect(r.body.data.answer).toMatch(/עוד לא למדתי/);
    expect(H.model.calls).toBe(0);
  });

  it("an excerpt scoring 0.3 that answers it is used (short Hebrew questions score low - measured on dev)", async () => {
    H.chunks = [{ content: "Urban Supply sells urban everyday goods.", score: 0.3, documentTitle: "Shipping policy", documentId: "doc_ship" }];
    H.model.content = JSON.stringify({ answer: "We sell urban everyday goods.", covered: true, used: [1] });
    const r = await ask("מה אתם מוכרים?");
    expect(r.body.data.grounded).toBe(true);
    expect(H.model.calls).toBe(1);
  });

  it("★ Hebrew Knowledge, an English question: the model is told a translated, general answer is covered; it is grounded with the Hebrew source", async () => {
    H.chunks = [{ content: "אתר חנות מקוונת למוצרים אורבניים, אופנה ואביזרים.", score: 0.32, documentTitle: "Shipping policy", documentId: "doc_ship" }];
    H.model.content = JSON.stringify({ answer: "We are an online store for urban goods, fashion and accessories.", covered: true, used: [1] });
    const r = await ask("What do you sell?", { locale: "en" });
    expect(r.body.data).toMatchObject({ grounded: true, sources: [{ documentId: "doc_ship" }] });
    const system = H.model.messages[0].content;
    // Measured on dev: without these two rules the model refused "What do you sell?".
    expect(system).toMatch(/another language than the question: translate/);
    expect(system).toMatch(/general answer the excerpts support .* is covered/);
    expect(H.model.messages[1].content).toMatch(/Question: What do you sell\?[\s\S]*אתר חנות מקוונת/);
  });

  it("★ the model saying the excerpts do not cover it is not grounded either", async () => {
    H.chunks = [{ content: "Returns within 14 days.", score: 0.7, documentTitle: "Returns", documentId: "doc_ret" }];
    // It even cites an excerpt: "covered: false" alone must make it ungrounded.
    H.model.content = JSON.stringify({ answer: "Probably yes!", covered: false, used: [1] });
    const r = await ask("Do you deliver to Eilat?");
    expect(r.body.data).toEqual({ answer: expect.stringMatching(/don't have this/), grounded: false, sources: [] });
  });

  it("★ nothing is recorded as business state, but the AI interaction is audited", async () => {
    H.chunks = [{ content: "We ship in 3 days.", score: 0.8, documentTitle: "Shipping policy", documentId: "doc_ship" }];
    H.model.content = JSON.stringify({ answer: "3 days.", covered: true, used: [1] });
    expect((await ask("How long does shipping take?")).status).toBe(200); // any write would have thrown → 500
    expect(H.retrievalOpts).toEqual([{ record: false }]);
    expect(H.audits).toHaveLength(1);
    expect(H.audits[0]).toMatchObject({
      action: "ai.onboarding_preview_answer", actorId: "u1", tenantId: "T",
      metadata: { question: "How long does shipping take?", grounded: true, sources: ["doc_ship"], modelCalled: true, tokens: { input: 120, output: 40 } },
    });
  });

  it("an AGENT gets 403; a suspended workspace 403; ACTIVE is allowed", async () => {
    H.role = "AGENT";
    expect((await ask("hi there question")).status).toBe(403);
    H.role = "ADMIN"; H.status = "SUSPENDED";
    expect((await ask("hi there question")).body.code).toBe("TENANT_STATUS");
    H.status = "ACTIVE";
    expect((await ask("hi there question")).status).toBe(200);
  });

  it("★ 20 a minute per tenant, then 429 with a wait", async () => {
    for (let i = 0; i < 20; i++) expect((await ask(`question number ${i}`)).status).toBe(200);
    const r = await ask("one too many");
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ code: "PREVIEW_RATE_LIMITED" });
    expect(r.body.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("question length and billing refusals", async () => {
    expect((await ask("   ")).body.code).toBe("QUESTION_REQUIRED");
    expect((await ask("x".repeat(301))).body).toMatchObject({ code: "QUESTION_TOO_LONG", max: 300 });
    H.chunks = [{ content: "We ship in 3 days.", score: 0.8, documentTitle: "Shipping policy", documentId: "doc_ship" }];
    H.billingDeny = "no_subscription";
    const r = await ask("How long does shipping take?");
    expect(r.status).toBe(402);
    expect(r.body.code).toBe("no_subscription");
  });
});

describe("★ onboarding-preview-questions", () => {
  const discovery = {
    knowledge: { policies: {
      shipping: { found: true, confidence: "likely" },
      returns: { found: true, confidence: "confirmed" },
      refunds: { found: false, confidence: "needs_verification" },
      privacy: { found: true, confidence: "low" },
    } },
    gaps: [
      // About contact, but a TECHNOLOGY gap: not a customer-facing question.
      { id: "gap_contact_widget", domain: "technology", label: "No contact form widget installed", severity: "high" },
      { id: "gap_contact_channels", domain: "communication", label: "No visible contact channels", severity: "high" },
    ],
  };

  it("found policies by confidence; capped at 3; a not-found policy is never a question", () => {
    expect(suggestedQuestions(discovery, "en", 3)).toEqual([
      { question: "How do returns work?", basis: "policy:returns" },
      { question: "What is your shipping policy?", basis: "policy:shipping" },
      { question: "What do you do with my personal details?", basis: "policy:privacy" },
    ]);
    expect(suggestedQuestions(discovery, "en", 3).some((q) => q.basis === "policy:refunds")).toBe(false);
  });

  it("then at most ONE customer-facing gap (a technology gap is not one)", () => {
    const onlyGaps = { knowledge: { policies: { shipping: { found: false } } }, gaps: [...discovery.gaps, { id: "gap_policy_texts", domain: "knowledge", label: "Shipping policy text not reachable", severity: "medium" }] };
    expect(suggestedQuestions(onlyGaps, "en", 3)).toEqual([{ question: "How can I reach you?", basis: "gap:gap_contact_channels" }]);
  });

  it("Hebrew templates, without a wide dash", () => {
    const he = suggestedQuestions(discovery, "he", 3);
    expect(he[0]).toEqual({ question: "איך עובדות החזרות?", basis: "policy:returns" });
    expect(JSON.stringify(he)).not.toMatch(/[–—―]/);
  });

  it("the route: real unanswered first (newest, up to 3), suggested only fills the rest", async () => {
    H.discovery = discovery;
    H.unanswered = [
      { id: "q1", tenantId: "T", question: "Do you ship to Eilat?", askCount: 4, resolvedAt: null },
      { id: "q2", tenantId: "T", question: "Is the coat waterproof?", askCount: 2, resolvedAt: null },
    ];
    const r = await request(app).get("/api/ai-assist/onboarding-preview-questions?locale=en");
    expect(r.status).toBe(200);
    expect(r.body.data.real).toEqual([{ id: "q1", question: "Do you ship to Eilat?", askCount: 4 }, { id: "q2", question: "Is the coat waterproof?", askCount: 2 }]);
    expect(r.body.data.suggested).toEqual([{ question: "How do returns work?", basis: "policy:returns" }]);
    H.role = "AGENT";
    expect((await request(app).get("/api/ai-assist/onboarding-preview-questions")).status).toBe(403);
  });
});
