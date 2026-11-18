/**
 * The knowledge-only rerun and the auto-approve step (2026-11-18, Smoovee): only PENDING candidates and their
 * vectors go; only the knowledge stages run; auto-approve goes through the bulk-approve path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  imp: { id: "imp1", status: "COMPLETED", sourceProgress: 100 } as any,
  cands: [] as any[], evidence: [] as any[], deleted: [] as any[], vectors: [] as string[][], events: [] as any[],
  stages: [] as string[], docs: [] as any[], audits: [] as any[], existing: null as any,
}));
vi.mock("@chatcenter/shared", async (orig) => {
  const actual: any = await orig();
  const db: any = {
    historicalImport: { findFirst: async () => H.imp },
    knowledgeCandidate: {
      findMany: async ({ where }: any) => H.cands.filter((c) => (where.status ? c.status === where.status : true)),
      count: async ({ where }: any) => H.cands.filter((c) => (where.status?.not ? c.status !== where.status.not : c.status === where.status)).length,
      deleteMany: (a: any) => ({ op: "candidates", a }),
      findFirst: async ({ where }: any) => H.cands.find((c) => c.id === where.id && c.status === where.status && (where.conflict === undefined || c.conflict === where.conflict)) ?? null,
      updateMany: async ({ where, data }: any) => { Object.assign(H.cands.find((c) => c.id === where.id), data); return { count: 1 }; },
    },
    historicalImportEvent: { deleteMany: (a: any) => ({ op: "events", a }) },
    knowledgeCandidateEvidence: { findMany: async () => H.evidence },
    knowledgeBase: { findFirst: async () => ({ id: "kb1" }) },
    knowledgeDocument: { create: async ({ data }: any) => { const d = { id: `doc${H.docs.length + 1}`, ...data }; H.docs.push(d); return d; } },
    $transaction: async (ops: any[]) => { H.deleted.push(...ops); return ops; },
  };
  return { ...actual, prisma: db, withHistoricalRecords: (f: any) => f(), writeAudit: async (a: any) => { H.audits.push(a); } };
});
vi.mock("../services/historical-intelligence/candidate-index", () => ({
  dropCandidateVectors: async (_t: string, ids: string[]) => { H.vectors.push(ids); },
  findExistingKnowledge: async () => H.existing,
}));
vi.mock("../services/embedding.service", () => ({ processDocument: async () => undefined }));
vi.mock("../services/historical-intelligence/stage-utils", async (orig) => ({ ...(await orig<any>()), recordEvent: async (_i: string, step: string, outcome: string) => { H.events.push(`${step}:${outcome}`); } }));
vi.mock("../services/historical-intelligence/knowledge-extraction.stage", async (orig) => ({ ...(await orig<any>()), runKnowledgeExtractionStage: async () => { H.stages.push("extraction"); return { ok: true, done: H.stages.filter((s) => s === "extraction").length >= 2 }; } }));
vi.mock("../services/historical-intelligence/knowledge-clustering.stage", async (orig) => ({ ...(await orig<any>()), runKnowledgeClusteringStage: async () => { H.stages.push("clustering"); return { ok: true }; } }));
vi.mock("../services/historical-intelligence/knowledge-dedupe.stage", async (orig) => ({ ...(await orig<any>()), runKnowledgeDedupeStage: async () => { H.stages.push("dedupe"); return { ok: true }; } }));
vi.mock("../services/historical-intelligence/knowledge-curation.stage", async (orig) => ({ ...(await orig<any>()), runKnowledgeCurationStage: async () => { H.stages.push("curation"); return { ok: true }; } }));
vi.mock("../services/historical-intelligence/knowledge-review.stage", async (orig) => ({ ...(await orig<any>()), runKnowledgeReviewStage: async () => { H.stages.push("review"); return { ok: true }; }, humanSourcedIds: async () => new Set(H.cands.map((c) => c.id)) }));

import { rerunKnowledgeOnly } from "../services/historical-intelligence/knowledge-rerun";
import { autoApproveImport } from "../services/historical-intelligence/approve";
import { parseRerunArgs } from "../scripts/rerun-knowledge";

const cand = (o: any) => ({ id: "c", status: "PENDING", question: "איך מממשים נקודות?", answer: "באזור האישי.", reasoning: null, topic: "נקודות", category: "PRICING_AND_DISCOUNTS", occurrenceCount: 5, customerCount: 4, conflict: false, variants: [], curationVerdict: "kept", curationNote: null, requiresLiveLookup: false, ...o });

beforeEach(() => { Object.assign(H, { imp: { id: "imp1", status: "COMPLETED", sourceProgress: 100 }, cands: [], evidence: [], deleted: [], vectors: [], events: [], stages: [], docs: [], audits: [], existing: null }); });

describe("knowledge-only rerun", () => {
  it("★ only PENDING candidates and their vectors; only the knowledge stages, in order", async () => {
    H.cands = [cand({ id: "p1" }), cand({ id: "p2" }), cand({ id: "a1", status: "APPROVED" }), cand({ id: "r1", status: "REJECTED" })];
    const r = await rerunKnowledgeOnly({ tenantId: "T", importId: "imp1" });
    expect(r).toMatchObject({ ok: true, pendingDeleted: 2, kept: 2, extractionBatches: 2 });
    expect(H.vectors.flat()).toEqual(["p1", "p2"]);
    expect(H.deleted.find((d) => d.op === "candidates").a.where).toEqual({ tenantId: "T", importId: "imp1", status: "PENDING" });
    expect(H.deleted.find((d) => d.op === "events").a.where).toEqual({ importId: "imp1", step: "KNOWLEDGE_EXTRACTION" });
    expect(H.stages).toEqual(["extraction", "extraction", "clustering", "dedupe", "curation", "review"]);
  });
  it("★ dry: counts only, nothing deleted or run; an unsettled import is refused", async () => {
    H.cands = [cand({ id: "p1" })];
    expect(await rerunKnowledgeOnly({ tenantId: "T", importId: "imp1", dryRun: true })).toMatchObject({ ok: true, dryRun: true, pendingDeleted: 1 });
    expect(H.deleted).toEqual([]);
    expect(H.vectors).toEqual([]);
    expect(H.stages).toEqual([]);
    H.imp = { id: "imp1", status: "KNOWLEDGE_EXTRACTION", sourceProgress: 100 };
    expect((await rerunKnowledgeOnly({ tenantId: "T", importId: "imp1" })).ok).toBe(false);
  });
});

describe("auto-approve", () => {
  it("★ approves what autoApprovable says yes to, through the approve path, decidedBy auto; dry writes nothing", async () => {
    H.cands = [
      cand({ id: "good" }),
      cand({ id: "rare", occurrenceCount: 2 }),
      cand({ id: "settled", conflict: true, variants: [{ answer: "נשר", firstSeenAt: "2026-01-01", lastSeenAt: "2026-05-01" }, { answer: "טבעון", firstSeenAt: "2026-06-01", lastSeenAt: "2026-10-01" }] }),
      cand({ id: "torn", conflict: true, variants: [{ answer: "a", firstSeenAt: "2026-01-01", lastSeenAt: "2026-10-01" }, { answer: "b", firstSeenAt: "2026-06-01", lastSeenAt: "2026-10-02" }] }),
      cand({ id: "live", requiresLiveLookup: true }),
    ];
    const dry = await autoApproveImport({ tenantId: "T", importId: "imp1", dryRun: true, force: true });
    expect(dry.ids.sort()).toEqual(["good", "settled"]);
    expect(H.docs).toEqual([]);
    const r = await autoApproveImport({ tenantId: "T", importId: "imp1", force: true });
    expect(r.approved).toBe(2);
    expect(H.cands.find((c) => c.id === "good")).toMatchObject({ status: "APPROVED", decidedBy: "auto" });
    expect(H.cands.find((c) => c.id === "torn").status).toBe("PENDING");
    expect(H.audits[0]).toMatchObject({ actorType: "system", actorId: "auto", metadata: { auto: true } });
  });
  it("★ off unless the flag is on or the run is forced; already covered is superseded, not approved", async () => {
    H.cands = [cand({ id: "good" })];
    expect(await autoApproveImport({ tenantId: "T", importId: "imp1" })).toMatchObject({ enabled: false, approved: 0 });
    H.existing = { documentId: "kbdoc", title: "x" };
    const r = await autoApproveImport({ tenantId: "T", importId: "imp1", force: true });
    expect(r).toMatchObject({ approved: 0, skipped: { "already covered": 1 } });
    expect(H.cands[0].status).toBe("SUPERSEDED");
  });
  it("★ approveOne in auto mode refuses an unresolved conflict itself (not only the filter before it)", async () => {
    const { approveOne } = await import("../services/historical-intelligence/approve");
    H.cands = [cand({ id: "torn", conflict: true, variants: [{ answer: "a", firstSeenAt: "2026-01-01", lastSeenAt: "2026-10-01" }, { answer: "b", firstSeenAt: "2026-06-01", lastSeenAt: "2026-10-02" }] })];
    expect(await approveOne("T", "torn", "auto", { auto: true })).toMatchObject({ ok: false, reason: "unresolved conflict" });
    expect(H.docs).toEqual([]);
  });
  it("script args", () => {
    expect(parseRerunArgs(["--import", "i", "--dry"])).toEqual({ importId: "i", dry: true, autoApprove: false, rerun: true });
    expect(parseRerunArgs(["--import", "i", "--auto-approve", "--no-rerun"])).toEqual({ importId: "i", dry: false, autoApprove: true, rerun: false });
    expect(() => parseRerunArgs(["--import", "i", "--no-rerun"])).toThrow(/does nothing/);
  });
});
