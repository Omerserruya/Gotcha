/**
 * ★ Imported history obeys a private-number rule made AFTER the import.
 * Ingest only stopped new messages; the rows the import brought in stayed
 * readable through the import routes (2026-10-08). At read time now:
 *   - a suggestion's examples leave out a private number's exchanges, before the cap
 *   - the imported customers list leaves them out
 *   - their thread and their memory read as not found
 *   - the conversation panel's history context is empty for that number
 * A rule on another number, or on the same number on another of the
 * business's numbers, hides nothing here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ rules: [] as any[], convs: [] as any[], evidence: [] as any[], customers: [] as any[], memory: [] as any[], messages: [] as any[] }));

function match(row: any, w: any): boolean {
  return Object.entries(w ?? {}).every(([k, v]: [string, any]) => {
    if (k === "OR") return v.some((x: any) => match(row, x));
    if (k === "NOT") return !match(row, v);
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("in" in v) return v.in.includes(row[k]);
      if ("notIn" in v) return !v.notIn.includes(row[k]);
      if ("not" in v) return (row[k] ?? null) !== v.not;
      return true;
    }
    return (row[k] ?? null) === v;
  });
}
const rows = (list: any[], a: any) => {
  let out = list.filter((r) => match(r, a.where));
  if (a.distinct) { const seen = new Set(); out = out.filter((r) => { const k = r[a.distinct[0]]; if (seen.has(k)) return false; seen.add(k); return true; }); }
  return a.take ? out.slice(0, a.take) : out;
};

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireOnboardingOrActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requirePermissionOrRole: () => (_q: any, _s: any, n: any) => n(),
    withHistoricalRecords: (fn: any) => fn(),
    prisma: {
      inboundExclusion: { findMany: async (a: any) => H.rules.filter((r) => r.tenantId === a.where.tenantId) },
      conversation: {
        findMany: async (a: any) => rows(H.convs, a),
        findFirst: async (a: any) => rows(H.convs, a)[0] ?? null,
      },
      knowledgeCandidate: { findFirst: async (a: any) => (a.where.id === "cand" && a.where.tenantId === "T" ? { id: "cand" } : null) },
      knowledgeCandidateEvidence: { findMany: async (a: any) => rows(H.evidence, a) },
      historicalCustomer: {
        findMany: async (a: any) => rows(H.customers, a),
        findFirst: async (a: any) => rows(H.customers, a)[0] ?? null,
      },
      customerHistoricalMemory: { findFirst: async (a: any) => H.memory.find((m) => m.tenantId === a.where.tenantId && (a.where.customerExternalId?.in ?? [a.where.customerExternalId]).includes(m.customerExternalId)) ?? null },
      message: { findMany: async (a: any) => rows(H.messages, a) },
    },
  };
});
vi.mock("../services/embedding.service", () => ({ processDocument: async () => undefined }));
vi.mock("../services/historical-intelligence/candidate-index", () => ({ findExistingKnowledge: async () => [] }));
vi.mock("../services/historical-intelligence/knowledge-clustering.stage", () => ({ BULK_APPROVE_MIN_CONFIDENCE: 0.8 }));
vi.mock("../services/historical-intelligence", () => ({ rerunIntelligence: async () => undefined }));

import router from "../routes/historical-import";

const app = express();
app.use(express.json());
app.use("/api/historical-imports", router);

const conv = (id: string, phone: string, o: any = {}) => ({ id, tenantId: "T", origin: "HISTORICAL_IMPORT", channel: "WHATSAPP", channelAccountId: "wa1", customerExternalId: phone, customerName: id, ...o });
/** Made AFTER the import: the rows below were all written before it. */
const ruleOn = (digits: string, channelAccountId: string | null = null) => H.rules.push({ tenantId: "T", channel: "WHATSAPP", channelAccountId, customerExternalId: digits });

beforeEach(() => {
  H.rules = [];
  H.convs = [conv("c_family", "972541111111"), conv("c_dana", "972542222222")];
  // 60 of the family's exchanges first (newest), then Dana's: the cap of 50 must still be filled by shown ones.
  H.evidence = [
    ...Array.from({ length: 60 }, (_, i) => ({ id: `ef${i}`, candidateId: "cand", tenantId: "T", conversationId: "c_family", questionText: "family q", answerText: "a", occurredAt: new Date(2026, 9, 8, 12, 0, 60 - i), variantKey: null })),
    { id: "ed", candidateId: "cand", tenantId: "T", conversationId: "c_dana", questionText: "Do you ship?", answerText: "Yes", occurredAt: new Date(2026, 9, 1), variantKey: null },
    { id: "enone", candidateId: "cand", tenantId: "T", conversationId: null, questionText: "unlinked", answerText: "x", occurredAt: new Date(2026, 8, 1), variantKey: null },
  ];
  H.customers = [
    { id: "hc_family", tenantId: "T", importId: "imp", externalId: "972541111111", normalizedPhone: "972541111111", conversationId: "c_family", messageCount: 9 },
    { id: "hc_dana", tenantId: "T", importId: "imp", externalId: "972542222222", normalizedPhone: "972542222222", conversationId: "c_dana", messageCount: 3 },
    // Imported with no conversation linked: only the number can say it is private.
    { id: "hc_family_unlinked", tenantId: "T", importId: "imp_old", externalId: "+972 54 111 1111", normalizedPhone: "972541111111", conversationId: null, messageCount: 1 },
  ];
  H.memory = [
    { tenantId: "T", customerExternalId: "972541111111", summary: "Family member", facts: [], messageCount: 9, source: "x", updatedAt: new Date(), importId: "imp" },
    { tenantId: "T", customerExternalId: "972542222222", summary: "Buys weekly", facts: [], messageCount: 3, source: "x", updatedAt: new Date(), importId: "imp" },
  ];
  H.messages = [{ id: "m1", tenantId: "T", conversationId: "c_family", direction: "INBOUND", body: "private", messageType: "text", createdAt: new Date() }];
});

const get = (path: string) => request(app).get(`/api/historical-imports${path}`);

describe("★ a rule made after the import hides what the import brought in", () => {
  it("before any rule: everything reads (the control)", async () => {
    expect((await get("/candidates/cand/evidence")).body.evidence).toHaveLength(50);
    expect((await get("/imp/customers")).body.customers.map((c: any) => c.id)).toEqual(["hc_family", "hc_dana"]);
    expect((await get("/conversations/c_family/messages")).status).toBe(200);
    expect((await get("/customers/hc_family/memory")).body.memory.summary).toBe("Family member");
    expect((await get("/customers/hc_family_unlinked/memory")).body.memory.summary).toBe("Family member");
    expect((await get("/customer-context?externalId=972541111111")).body.context.summary).toBe("Family member");
  });

  it("a channel-wide rule on the family's number: examples, customers, thread, memory and context all leave them out", async () => {
    ruleOn("972541111111");
    const ev = (await get("/candidates/cand/evidence")).body.evidence;
    // Excluded before the cap: the shown ones fill it.
    expect(ev.map((e: any) => e.conversationId)).toEqual(["c_dana", null]);
    expect((await get("/imp/customers")).body.customers.map((c: any) => c.id)).toEqual(["hc_dana"]);
    expect((await get("/conversations/c_family/messages")).status).toBe(404);
    expect((await get("/customers/hc_family/memory")).status).toBe(404);
    // The panel asks by the number as the conversation holds it.
    expect((await get("/customer-context?externalId=972541111111")).body.context).toBeNull();
    // A customer with no conversation linked: the number alone hides their memory.
    expect((await get("/customers/hc_family_unlinked/memory")).status).toBe(404);
    // Dana is untouched.
    expect((await get("/customers/hc_dana/memory")).body.memory.summary).toBe("Buys weekly");
    expect((await get("/conversations/c_dana/messages")).status).toBe(200);
  });

  it("a rule on the same number but another of the business's numbers hides nothing of this thread", async () => {
    ruleOn("972541111111", "wa_other");
    expect((await get("/conversations/c_family/messages")).status).toBe(200);
    expect((await get("/imp/customers")).body.customers.map((c: any) => c.id)).toEqual(["hc_family", "hc_dana"]);
  });
});
