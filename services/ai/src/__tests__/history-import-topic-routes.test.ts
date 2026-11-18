/** Approval by topic (2026-11-18, Omer; Frontend's contract): stable topicId, status, approve-all, reject and undo auto. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ cands: [] as any[], event: null as any, approve: [] as any[], vecDel: [] as string[], docDel: [] as any[] }));
vi.mock("@chatcenter/shared", async (orig) => {
  const actual: any = await orig();
  const pass = (_q: any, _s: any, n: any) => n();
  return {
    ...actual,
    authenticate: (req: any, _s: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _s: any, n: any) => { req.tenantId = "T"; n(); },
    requireOnboardingOrActiveTenant: () => pass,
    requirePermissionOrRole: () => pass,
    withHistoricalRecords: (f: any) => f(),
    writeAudit: async () => undefined,
    prisma: {
      historicalImport: { findFirst: async ({ where }: any) => (where.tenantId === "T" && where.id === "imp1" ? { id: "imp1" } : null) },
      historicalImportEvent: { findFirst: async () => H.event },
      knowledgeCandidate: {
        findMany: async ({ where }: any) => H.cands.filter((c) => where.id.in.includes(c.id)),
        updateMany: async ({ where, data }: any) => {
          let n = 0;
          for (const c of H.cands) if (where.OR.some((o: any) => o.id.in.includes(c.id) && c.status === o.status && (!o.decidedBy || c.decidedBy === o.decidedBy))) { Object.assign(c, data); n++; }
          return { count: n };
        },
      },
      knowledgeCandidateEvidence: { findMany: async () => [] },
      knowledgeDocument: { deleteMany: async (a: any) => { H.docDel.push(a.where.id); return { count: 1 }; } },
    },
  };
});
vi.mock("../services/historical-intelligence/approve", async (orig) => ({ ...(await orig<any>()), approveOne: async (_t: string, id: string, _u: string, opts: any) => { H.approve.push({ id, ...opts }); return { ok: true, documentId: `d_${id}` }; } }));
vi.mock("../services/qdrant.service", () => ({ deleteByDocumentId: async (id: string) => { H.vecDel.push(id); }, deleteByKnowledgeBaseId: async () => undefined }));
vi.mock("../services/embedding.service", () => ({ processDocument: async () => undefined }));

import router, { topicStatus } from "../routes/historical-import";
const app = express();
app.use(express.json());
app.use("/api/historical-imports", router);

const c = (id: string, o: any = {}) => ({ id, topic: "משלוחים", category: "SHIPPING_AND_DELIVERY", question: `q ${id}`, answer: `a ${id}`, status: "PENDING", conflict: false, variants: [], decidedBy: null, approvedDocumentId: null, ...o });
const torn = [{ answer: "עד 3", firstSeenAt: "2026-09-01", lastSeenAt: "2026-10-01" }, { answer: "עד 7", firstSeenAt: "2026-08-01", lastSeenAt: "2026-10-02" }];
beforeEach(() => {
  H.cands = [c("a"), c("b", { conflict: true, variants: torn }), c("x", { topic: "החזרות" })];
  H.event = { id: "ev1", createdAt: new Date(), detail: { topics: [{ label: "משלוחים", category: "SHIPPING_AND_DELIVERY", candidateIds: ["a", "b"] }, { label: "החזרות", category: "RETURNS_AND_CANCELLATION", candidateIds: ["x"] }], choices: { a: { chosen: { value: "35 ₪", basis: "latest", at: "2026-11-12" }, previous: { value: "30 ₪", until: "2026-06-01" } } } } };
  H.approve = []; H.vecDel = []; H.docDel = [];
});

describe("topics", () => {
  it("★ a stable topicId, a status, items with chosen and previous, progress", async () => {
    const r = await request(app).get("/api/historical-imports/imp1/topics");
    expect(r.status).toBe(200);
    const t = r.body.topics[0];
    expect(t.topicId).toMatch(/^[0-9a-f]{16}$/);
    expect((await request(app).get("/api/historical-imports/imp1/topics")).body.topics[0].topicId).toBe(t.topicId);
    expect(t.status).toBe("pending");
    expect(t.items.find((i: any) => i.candidateId === "a")).toMatchObject({ chosen: { value: "35 ₪", basis: "latest" }, previous: { value: "30 ₪" }, unresolved: false });
    expect(t.items.find((i: any) => i.candidateId === "b").unresolved).toBe(true);
    expect(r.body.progress).toEqual({ total: 2, done: 0 });
  });
  it("★ approve all of a topic; an unresolved item without an answer is a 400", async () => {
    const tid = (await request(app).get("/api/historical-imports/imp1/topics")).body.topics[0].topicId;
    const bad = await request(app).post("/api/historical-imports/topics/approve").send({ importId: "imp1", topicId: tid });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: "UNRESOLVED_ITEM", candidateIds: ["b"] });
    const ok = await request(app).post("/api/historical-imports/topics/approve").send({ importId: "imp1", topicId: tid, items: [{ candidateId: "b", answer: "עד 3 ימי עסקים" }] });
    expect(ok.body).toMatchObject({ ok: true, approved: 2 });
    expect(H.approve.map((a) => [a.id, a.answer])).toEqual([["a", null], ["b", "עד 3 ימי עסקים"]]);
    expect((await request(app).post("/api/historical-imports/topics/approve").send({ importId: "imp1", topicId: "nope" })).status).toBe(404);
  });
  it("★ reject a topic; undoing an auto topic removes its documents", async () => {
    H.cands = [c("a", { status: "APPROVED", decidedBy: "auto", approvedDocumentId: "doc1" }), c("b", { status: "APPROVED", decidedBy: "auto", approvedDocumentId: "doc2" })];
    const t = (await request(app).get("/api/historical-imports/imp1/topics")).body.topics[0];
    expect(t.status).toBe("auto");
    const r = await request(app).post("/api/historical-imports/topics/reject").send({ importId: "imp1", topicId: t.topicId });
    expect(r.body).toMatchObject({ ok: true, rejected: 2, documentsRemoved: 2 });
    expect(H.vecDel).toEqual(["doc1", "doc2"]);
    expect(H.cands.every((x) => x.status === "REJECTED" && x.approvedDocumentId === null)).toBe(true);
  });
  it("a person's approval is never undone by a topic reject; statuses", async () => {
    H.cands = [c("a", { status: "APPROVED", decidedBy: "u9", approvedDocumentId: "doc1" }), c("b")];
    const t = (await request(app).get("/api/historical-imports/imp1/topics")).body.topics[0];
    await request(app).post("/api/historical-imports/topics/reject").send({ importId: "imp1", topicId: t.topicId });
    expect(H.cands.find((x) => x.id === "a").status).toBe("APPROVED");
    expect(H.docDel).toEqual([]);
    expect(topicStatus([{ status: "REJECTED" }])).toBe("rejected");
    expect(topicStatus([{ status: "APPROVED", decidedBy: "u1" }])).toBe("approved");
  });
});
