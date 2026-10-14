/**
 * Answering a question from an employee's readiness report (B2, 2026-10-14),
 * through the real route and the real readiness report:
 *   - the answer becomes knowledge (the same Q/A document as a gap answer),
 *     learned before it counts; a matching open unanswered question resolves
 *   - the next report counts the question as covered, once, and tells the
 *     auditor not to ask it again
 *   - the report reads the knowledge the employee reads at runtime: attached,
 *     tenant-wide, its department's and its own, never another employee's
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));

const H = vi.hoisted(() => ({
  user: { userId: "owner", role: "ADMIN", perms: [] as string[] },
  agents: [] as any[], kbs: [] as any[], docs: [] as any[], links: [] as any[], questions: [] as any[],
  settings: new Map<string, string>(), embedFails: false, n: 0, prompt: "", modelQuestions: [] as any[],
}));

const inList = (v: any, c: any) => (c && typeof c === "object" && "in" in c ? c.in.includes(v) : c === undefined || c === v);

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const pass = (_q: any, _s: any, n: any) => n();
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { ...H.user, tenantId: "T" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireActiveTenant: () => pass,
    requireOnboardingOrActiveTenant: () => pass,
    requirePermissionOrRole: (perm: string, role: string) => (req: any, res: any, n: any) =>
      req.user.perms.includes(perm) || req.user.role === role ? n() : res.status(403).json({ error: "Forbidden" }),
    requireEntitlement: () => pass,
    requireCapacity: () => pass,
    readDurableSetting: async (t: string, k: string) => H.settings.get(`${t}:${k}`) ?? null,
    writeDurableSetting: async (t: string, k: string, v: string) => { H.settings.set(`${t}:${k}`, v); },
    prisma: {
      aIAgent: { findFirst: async (a: any) => H.agents.find((x) => x.id === a.where.id && x.tenantId === a.where.tenantId) ?? null },
      aIAgentKnowledge: { findMany: async (a: any) => H.links.filter((l) => l.aiAgentId === a.where.aiAgentId) },
      knowledgeBase: {
        findMany: async (a: any) => H.kbs.filter((k) => k.tenantId === a.where.tenantId && inList(k.isActive, a.where.isActive) && inList(k.id, a.where.id)),
        findFirst: async (a: any) => H.kbs.find((k) => k.tenantId === a.where.tenantId && k.isActive === a.where.isActive && k.scope === a.where.scope) ?? null,
        create: async (a: any) => { const k = { id: `kb_${++H.n}`, isActive: true, scope: "all", ...a.data }; H.kbs.push(k); return k; },
      },
      knowledgeDocument: {
        findFirst: async (a: any) => H.docs.find((d) => d.tenantId === a.where.tenantId && d.metadata?.dedupeKey === a.where.metadata.equals) ?? null,
        findMany: async (a: any) => H.docs.filter((d) => d.tenantId === a.where.tenantId && inList(d.knowledgeBaseId, a.where.knowledgeBaseId)),
        create: async (a: any) => { const d = { id: `doc_${++H.n}`, ...a.data }; H.docs.push(d); return d; },
        update: async (a: any) => { const d = H.docs.find((x) => x.id === a.where.id); Object.assign(d, a.data); return d; },
      },
      unansweredQuestion: {
        findFirst: async (a: any) => H.questions.find((q) => q.tenantId === a.where.tenantId && q.clusterKey === a.where.clusterKey && q.resolvedAt === null) ?? null,
        update: async (a: any) => { const q = H.questions.find((x) => x.id === a.where.id); Object.assign(q, a.data); return q; },
      },
      businessProfile: { findUnique: async () => ({ organizationName: "Shop", industry: "retail", businessDescription: "" }) },
      agentToolPermission: { findMany: async () => [] },
    },
  };
});
vi.mock("../services/embedding.service", () => ({
  processDocument: async (id: string) => {
    const d = H.docs.find((x) => x.id === id);
    if (H.embedFails) { d.status = "error"; throw new Error("embedding provider down"); }
    d.status = "ready";
  },
}));
vi.mock("../services/qdrant.service", () => ({ deleteByDocumentId: async () => {} }));
vi.mock("../services/ai.service", () => ({
  generateResponse: vi.fn(async (o: any) => { H.prompt = o.messages[1].content; return { content: JSON.stringify({ questions: H.modelQuestions, recommendations: [] }) }; }),
}));

import { clusterKeyFor } from "@chatcenter/shared";
import router from "../routes/ai-agents";
import { generateReadinessReport } from "../services/agent-readiness.service";

const app = express();
app.use(express.json());
app.use("/api/ai-agents", router);
const answer = (id: string, body: any) => request(app).post(`/api/ai-agents/${id}/readiness-questions/answer`).send(body);

beforeEach(() => {
  H.user = { userId: "owner", role: "ADMIN", perms: [] };
  H.agents = [{ id: "maya", tenantId: "T", name: "Maya", role: "customer_support", goal: "help", successCriteria: "", identity: {}, departmentId: "d1" }];
  H.kbs = [
    { id: "kb_all", tenantId: "T", name: "Company", isActive: true, scope: "all" },
    { id: "kb_dept", tenantId: "T", name: "Support", isActive: true, scope: "department", scopeDepartmentId: "d1" },
    { id: "kb_mine", tenantId: "T", name: "Maya's", isActive: true, scope: "agent", scopeAgentId: "maya" },
    { id: "kb_theirs", tenantId: "T", name: "Dan's", isActive: true, scope: "agent", scopeAgentId: "dan" },
    { id: "kb_sales", tenantId: "T", name: "Sales", isActive: true, scope: "department", scopeDepartmentId: "d2" },
    { id: "kb_off", tenantId: "T", name: "Old", isActive: false, scope: "all" },
  ];
  H.docs = H.kbs.map((k, i) => ({ id: `seed_${i}`, tenantId: "T", knowledgeBaseId: k.id, title: `doc in ${k.id}`, content: "x", metadata: {} }));
  H.links = [];
  H.questions = [{ id: "uq1", tenantId: "T", question: "Do you ship to Eilat?", clusterKey: clusterKeyFor("Do you ship to Eilat?"), resolvedAt: null }];
  H.settings = new Map(); H.embedFails = false; H.n = 0; H.prompt = ""; H.modelQuestions = [];
});

describe("POST /:id/readiness-questions/answer", () => {
  it("★ the answer becomes knowledge, learned; the same open customer question resolves", async () => {
    const r = await answer("maya", { question: " Do you ship to Eilat? ", answer: "  Yes, 3-5 days.  " });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ knowledgeBaseId: "kb_all", resolvedUnansweredQuestionId: "uq1" });
    const doc = H.docs.find((d) => d.id === r.body.data.documentId);
    expect(doc).toMatchObject({ knowledgeBaseId: "kb_all", title: "Do you ship to Eilat?", content: "**Do you ship to Eilat?**\n\nYes, 3-5 days.", status: "ready" });
    expect(doc.metadata).toMatchObject({ origin: "readiness_question", aiAgentId: "maya", answeredBy: "owner" });
    expect(H.questions[0].resolvedAt).toBeInstanceOf(Date);
  });

  it("answering again replaces the same document and keeps one entry", async () => {
    const a = await answer("maya", { question: "Do you ship to Eilat?", answer: "Yes." });
    const b = await answer("maya", { question: "do you ship to eilat", answer: "Yes, now in 2 days." });
    expect(b.body.data.documentId).toBe(a.body.data.documentId);
    expect(JSON.parse(H.settings.get("T:agent:readiness-answered:maya")!)).toHaveLength(1);
  });

  it("★ not learned: 502 NOT_LEARNED, and the question is neither remembered nor resolved", async () => {
    H.embedFails = true;
    const r = await answer("maya", { question: "Do you ship to Eilat?", answer: "Yes." });
    expect(r.status).toBe(502);
    expect(r.body.code).toBe("NOT_LEARNED");
    expect(H.settings.has("T:agent:readiness-answered:maya")).toBe(false);
    expect(H.questions[0].resolvedAt).toBeNull();
  });

  it("bad input: 400 with a code, nothing written", async () => {
    for (const [body, code] of [
      [{ answer: "Yes." }, "QUESTION_REQUIRED"],
      [{ question: "q".repeat(401), answer: "Yes." }, "QUESTION_TOO_LONG"],
      [{ question: "Q?" }, "ANSWER_REQUIRED"],
      [{ question: "Q?", answer: "a".repeat(20001) }, "ANSWER_TOO_LONG"],
    ] as const) {
      const r = await answer("maya", body);
      expect(r.status).toBe(400);
      expect(r.body.code).toBe(code);
    }
    expect(H.docs.filter((d) => d.id.startsWith("doc_"))).toEqual([]);
  });

  it("another tenant's employee: 404 AGENT_NOT_FOUND, nothing written", async () => {
    H.agents.push({ id: "theirs", tenantId: "OTHER" });
    const r = await answer("theirs", { question: "Q?", answer: "Yes." });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("AGENT_NOT_FOUND");
    expect(H.docs.filter((d) => d.id.startsWith("doc_"))).toEqual([]);
  });

  it("without the knowledge write permission: 403", async () => {
    H.user = { userId: "agent1", role: "AGENT", perms: ["ai:knowledge:read"] };
    expect((await answer("maya", { question: "Q?", answer: "Yes." })).status).toBe(403);
  });
});

describe("the next readiness report", () => {
  it("★ counts the answered question as covered, once, and tells the auditor not to ask it", async () => {
    await answer("maya", { question: "Do you ship to Eilat?", answer: "Yes." });
    H.modelQuestions = [
      { question: "Do you ship to Eilat?", coverage: "none", gapType: "knowledge", reason: "r" },
      { question: "What sizes do you have?", coverage: "none", gapType: "data", reason: "r" },
    ];
    const r: any = await generateReadinessReport("T", "maya", "en");
    expect(H.prompt).toContain("Questions the business already answered");
    expect(H.prompt).toContain("- Do you ship to Eilat?");
    const eilat = r.questions.filter((q: any) => clusterKeyFor(q.question) === clusterKeyFor("Do you ship to Eilat?"));
    expect(eilat).toEqual([expect.objectContaining({ coverage: "full", gapType: "none", answered: true })]);
    expect(r.totals).toEqual({ full: 1, partial: 0, none: 1, total: 2 });
    expect(r.score).toBe(50);
  });

  it("with nothing answered the report is as before", async () => {
    H.modelQuestions = [{ question: "What sizes do you have?", coverage: "none", gapType: "data", reason: "r" }];
    const r: any = await generateReadinessReport("T", "maya", "en");
    expect(H.prompt).not.toContain("already answered");
    expect(r.totals.total).toBe(1);
  });

  it("★ reads the knowledge the employee reads at runtime, not only what is attached", async () => {
    await generateReadinessReport("T", "maya", "en");
    for (const kb of ["kb_all", "kb_dept", "kb_mine"]) expect(H.prompt).toContain(`doc in ${kb}`);
    for (const kb of ["kb_theirs", "kb_sales", "kb_off"]) expect(H.prompt).not.toContain(`doc in ${kb}`);
  });
});
