/**
 * ★ Answering a question the AI could not (design 08), through the real route:
 *   - another workspace's question is 404, and nothing is written for it
 *   - answering takes ai:knowledge:write (or ADMIN); reading does not grant it
 *   - the answer becomes a question-and-answer document in an ACTIVE knowledge
 *     base, kept exactly as written, and is embedded before the question
 *     counts as answered
 *   - answering again REPLACES the same document and drops its old vectors
 *   - an answer that did not embed leaves the question open (NOT_LEARNED)
 *   - the answered question leaves the open list and shows as answered
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));
vi.mock("ioredis", () => ({ default: class { on = vi.fn(); quit = vi.fn(); async get() { return null; } async set() { return "OK"; } } }));

const H = vi.hoisted(() => ({
  user: { userId: "owner", role: "ADMIN", perms: [] as string[] },
  questions: [] as any[], docs: [] as any[], kbs: [] as any[],
  embedFails: false, embedded: [] as string[], vectorsDropped: [] as string[], n: 0,
}));

function match(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
    if (k === "metadata" && v?.path) return row.metadata?.[v.path[0]] === v.equals;
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("not" in v) return row[k] !== v.not;
      return true;
    }
    return (row[k] ?? null) === v;
  });
}

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { ...H.user, tenantId: "T1" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T1"; n(); },
    requireOnboardingOrActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    // The real rule's shape: the named permission, or the role.
    requirePermissionOrRole: (perm: string, role: string) => (req: any, res: any, n: any) =>
      req.user.perms.includes(perm) || req.user.role === role ? n() : res.status(403).json({ error: "Forbidden" }),
    prisma: {
      unansweredQuestion: {
        findFirst: async (a: any) => H.questions.find((q) => match(q, a.where)) ?? null,
        findMany: async (a: any) => H.questions.filter((q) => match(q, a.where)),
        update: async (a: any) => { const q = H.questions.find((x) => x.id === a.where.id); Object.assign(q, a.data); return q; },
      },
      knowledgeBase: {
        findFirst: async (a: any) => H.kbs.filter((k) => match(k, a.where))[0] ?? null,
        create: async (a: any) => { const k = { id: `kb_${++H.n}`, isActive: true, scope: "all", ...a.data }; H.kbs.push(k); return k; },
      },
      knowledgeDocument: {
        findFirst: async (a: any) => H.docs.find((d) => match(d, a.where)) ?? null,
        create: async (a: any) => { const d = { id: `doc_${++H.n}`, ...a.data }; H.docs.push(d); return d; },
        update: async (a: any) => { const d = H.docs.find((x) => x.id === a.where.id); Object.assign(d, a.data); return d; },
      },
    },
  };
});
vi.mock("../services/embedding.service", () => ({
  processDocument: async (id: string) => {
    const d = H.docs.find((x) => x.id === id);
    if (H.embedFails) { d.status = "error"; throw new Error("embedding provider down"); }
    d.status = "ready"; H.embedded.push(id);
  },
}));
vi.mock("../services/qdrant.service", () => ({ deleteByDocumentId: async (id: string) => { H.vectorsDropped.push(id); } }));

import router from "../routes/unanswered-questions";

const app = express();
app.use(express.json());
app.use("/api", router);

const answer = (id: string, body: any) => request(app).post(`/api/knowledge/unanswered-questions/${id}/answer`).send(body);
const Q = (id: string, tenantId: string, question: string) => ({ id, tenantId, question, clusterKey: id, reason: "no_knowledge", askCount: 3, askedBy: 2, firstAskedAt: new Date("2026-10-01"), lastAskedAt: new Date("2026-10-07"), resolvedAt: null });

beforeEach(() => {
  H.user = { userId: "owner", role: "ADMIN", perms: [] };
  H.questions = [Q("q1", "T1", "Do you ship to Eilat?"), Q("q_other", "T2", "Their question")];
  // An inactive base and one only an agent reads come first: neither is where every employee looks.
  H.kbs = [{ id: "kb_off", tenantId: "T1", isActive: false, scope: "all" }, { id: "kb_agent", tenantId: "T1", isActive: true, scope: "agent" }, { id: "kb_on", tenantId: "T1", isActive: true, scope: "all" }];
  H.docs = []; H.embedFails = false; H.embedded = []; H.vectorsDropped = []; H.n = 0;
});

describe("★ answering an unanswered question", () => {
  it("the answer becomes knowledge in an active base, learned before the question counts as answered", async () => {
    const owner = "Yes \u2014 to Eilat in 3-5 days, ₪25.";
    const r = await answer("q1", { answer: `  ${owner}  ` });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ documentId: "doc_1", resolvedBy: "owner" });
    expect(Date.parse(r.body.data.resolvedAt)).not.toBeNaN();
    const doc = H.docs[0];
    // The owner's words exactly (their dash included); only the ends trimmed.
    expect(doc).toMatchObject({ tenantId: "T1", knowledgeBaseId: "kb_on", title: "Do you ship to Eilat?", content: `**Do you ship to Eilat?**\n\n${owner}`, status: "ready" });
    expect(doc.metadata).toMatchObject({ origin: "unanswered_question", dedupeKey: "unanswered_question:q1", answeredBy: "owner" });
    expect(H.embedded).toEqual(["doc_1"]);
    expect(H.questions[0].resolvedAt).toBeInstanceOf(Date);
  });

  it("★ the question leaves the open list and shows as answered", async () => {
    await answer("q1", { answer: "Yes." });
    const open = await request(app).get("/api/knowledge/unanswered-questions?status=open");
    expect(open.body.data.map((x: any) => x.id)).toEqual([]);
    const done = await request(app).get("/api/knowledge/unanswered-questions?status=answered");
    expect(done.body.data.map((x: any) => x.id)).toEqual(["q1"]);
  });

  it("★ answering again replaces the same knowledge, its old vectors dropped first", async () => {
    await answer("q1", { answer: "Yes, 5 days." });
    const first = H.questions[0].resolvedAt;
    await new Promise((ok) => setTimeout(ok, 5));
    const r = await answer("q1", { answer: "Yes, 3 days now." });
    expect(r.body.data.documentId).toBe("doc_1");
    expect(H.docs).toHaveLength(1);
    expect(H.docs[0].content).toBe("**Do you ship to Eilat?**\n\nYes, 3 days now.");
    expect(H.vectorsDropped).toEqual(["doc_1"]);
    expect(H.embedded).toEqual(["doc_1", "doc_1"]);
    expect(H.questions[0].resolvedAt.getTime()).toBeGreaterThan(first.getTime());
  });

  it("★ an answer that did not embed leaves the question open", async () => {
    H.embedFails = true;
    const r = await answer("q1", { answer: "Yes." });
    expect(r.status).toBe(502);
    expect(r.body.code).toBe("NOT_LEARNED");
    expect(H.questions[0].resolvedAt).toBeNull();
  });

  it("★ another workspace's question is 404, and nothing is written", async () => {
    const r = await answer("q_other", { answer: "Yes." });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("QUESTION_NOT_FOUND");
    expect(H.docs).toEqual([]);
    expect(H.questions[1].resolvedAt).toBeNull();
  });

  it("★ answering takes the write permission: an agent who may only read gets 403", async () => {
    H.user = { userId: "agent", role: "AGENT", perms: ["ai:knowledge:read"] };
    expect((await request(app).get("/api/knowledge/unanswered-questions")).status).toBe(200);
    const r = await answer("q1", { answer: "Yes." });
    expect(r.status).toBe(403);
    expect(H.docs).toEqual([]);
    H.user = { userId: "editor", role: "AGENT", perms: ["ai:knowledge:read", "ai:knowledge:write"] };
    expect((await answer("q1", { answer: "Yes." })).status).toBe(200);
  });

  it("an empty or too long answer is refused before anything is written", async () => {
    expect((await answer("q1", { answer: "   " })).body.code).toBe("ANSWER_REQUIRED");
    expect((await answer("q1", {})).body.code).toBe("ANSWER_REQUIRED");
    expect((await answer("q1", { answer: "x".repeat(20001) })).body.code).toBe("ANSWER_TOO_LONG");
    expect(H.docs).toEqual([]);
  });

  it("with no active tenant-wide knowledge base, one is created for it", async () => {
    H.kbs = [{ id: "kb_off", tenantId: "T1", isActive: false, scope: "all" }, { id: "kb_agent", tenantId: "T1", isActive: true, scope: "agent" }];
    await answer("q1", { answer: "Yes." });
    expect(["kb_off", "kb_agent"]).not.toContain(H.docs[0].knowledgeBaseId);
    expect(H.kbs.find((k) => k.id === H.docs[0].knowledgeBaseId)).toMatchObject({ tenantId: "T1", isActive: true, scope: "all" });
  });
});
