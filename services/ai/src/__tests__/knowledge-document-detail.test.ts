/**
 * GET /api/knowledge-bases/:id/documents/:docId (K6, 2026-10-11): one document
 * for the Knowledge center's drawer - tenant- and base-scoped, the list's own
 * permission, capped text, what the AI reads, and no secrets.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));
vi.mock("ioredis", () => ({ default: class { on = vi.fn(); quit = vi.fn(); async get() { return null; } async set() { return "OK"; } } }));

const H = vi.hoisted(() => ({ deleted: [] as string[], docs: [] as any[], chunks: [] as any[], allow: true, permAsked: [] as string[] }));
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "AGENT" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireOnboardingOrActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requirePermissionOrRole: (key: string) => (_q: any, res: any, n: any) => { H.permAsked.push(key); return H.allow || key !== "ai:knowledge:read" ? n() : res.status(403).json({ error: "forbidden" }); },
    requireEntitlement: () => (_q: any, _s: any, n: any) => n(),
    requireCapacity: () => (_q: any, _s: any, n: any) => n(),
    prisma: {
      knowledgeDocument: { delete: async (a: any) => { H.deleted.push(a.where.id); return {}; }, findFirst: async (a: any) => H.docs.find((d) => d.id === a.where.id && d.knowledgeBaseId === a.where.knowledgeBaseId && d.tenantId === a.where.tenantId) ?? null },
      knowledgeBase: {
        findMany: async (a: any) => [{ id: "kb1", tenantId: a.where.tenantId, name: "Main", documents: H.docs.filter((d) => d.tenantId === a.where.tenantId) }],
      },
      knowledgeChunk: {
        count: async (a: any) => H.chunks.filter((c) => c.documentId === a.where.documentId && c.tenantId === a.where.tenantId).length,
        findMany: async (a: any) => H.chunks.filter((c) => c.documentId === a.where.documentId && c.tenantId === a.where.tenantId).sort((x, y) => x.chunkIndex - y.chunkIndex).slice(0, a.take),
      },
    },
  };
});

import router, { safeSourceUrl } from "../routes/knowledge";
const app = express();
app.use(express.json());
app.use("/api/knowledge-bases", router);

beforeEach(() => {
  H.allow = true; H.permAsked = [];
  H.docs = [
    { id: "d1", knowledgeBaseId: "kb1", tenantId: "T", title: "Returns policy", content: "R".repeat(25_000), sourceType: "google_drive",
      sourceUrl: "https://docs.google.com/document/d/abc/edit?usp=sharing&access_token=SECRET1", status: "ready", chunkCount: 3,
      metadata: { origin: "drive", topic: "returns", accessToken: "SECRET2", refreshToken: "SECRET3" }, createdAt: new Date(), updatedAt: new Date() },
    { id: "d2", knowledgeBaseId: "kb1", tenantId: "OTHER", title: "theirs", content: "x", sourceType: "text", sourceUrl: null, status: "ready", chunkCount: 0, metadata: null, createdAt: new Date(), updatedAt: new Date() },
  ];
  H.chunks = Array.from({ length: 60 }, (_, i) => ({ documentId: "d1", tenantId: "T", chunkIndex: i, content: `section ${i} ` + "s".repeat(500) }));
});

describe("GET /:id/documents/:docId", () => {
  it("the document, its text capped with the real length, and what the AI reads", async () => {
    const r = await request(app).get("/api/knowledge-bases/kb1/documents/d1");
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d).toMatchObject({ id: "d1", title: "Returns policy", type: "google_drive", status: "ready", contentLength: 25_000, truncated: true });
    expect(d.content).toHaveLength(20_000);
    expect(d.ai.sectionCount).toBe(60);
    expect(d.ai.sections).toHaveLength(50);
    expect(d.ai.sectionsTruncated).toBe(true);
    expect(d.ai.sections[0]).toEqual({ index: 0, length: 510, preview: ("section 0 " + "s".repeat(500)).slice(0, 240) });
    expect(d.ai.facts).toBeNull();
  });

  it("never a secret: no token in the URL, only allowlisted provenance metadata", async () => {
    const r = await request(app).get("/api/knowledge-bases/kb1/documents/d1");
    expect(JSON.stringify(r.body)).not.toMatch(/SECRET\d/);
    expect(r.body.data.sourceUrl).toBe("https://docs.google.com/document/d/abc/edit?usp=sharing");
    expect(r.body.data.metadata).toEqual({ origin: "drive", topic: "returns" });
  });

  it("another tenant's document, or one from another base: 404", async () => {
    expect((await request(app).get("/api/knowledge-bases/kb1/documents/d2")).status).toBe(404);
    expect((await request(app).get("/api/knowledge-bases/kb2/documents/d1")).status).toBe(404);
  });

  it("the list's own permission: without ai:knowledge:read, 403", async () => {
    H.allow = false;
    expect((await request(app).get("/api/knowledge-bases/kb1/documents/d1")).status).toBe(403);
    expect(H.permAsked).toContain("ai:knowledge:read");
  });
});

describe("safeSourceUrl", () => {
  it("drops credentials and credential-looking parameters, keeps the rest", () => {
    expect(safeSourceUrl("https://user:pass@x.atlassian.net/wiki/page?id=5&api_key=k&signature=s")).toBe("https://x.atlassian.net/wiki/page?id=5");
    expect(safeSourceUrl("not a url")).toBeNull();
    expect(safeSourceUrl(null)).toBeNull();
  });
});

describe("summary (B3, 2026-10-12): the stored line, never generated on read", () => {
  it("the drawer and the list both carry it", async () => {
    H.docs[0].metadata.summary = { text: "How returns work: 14 days, full refund.", lang: "en", hash: "h", at: "t" };
    const one = await request(app).get("/api/knowledge-bases/kb1/documents/d1");
    expect(one.body.data.summary).toBe("How returns work: 14 days, full refund.");
    const list = await request(app).get("/api/knowledge-bases");
    expect(list.status).toBe(200);
    expect(list.body.data[0].documents.map((d: any) => [d.id, d.summary])).toEqual([["d1", "How returns work: 14 days, full refund."]]);
  });

  it("null when none was made yet", async () => {
    const one = await request(app).get("/api/knowledge-bases/kb1/documents/d1");
    expect(one.body.data.summary).toBeNull();
    const list = await request(app).get("/api/knowledge-bases");
    expect(list.body.data[0].documents[0].summary).toBeNull();
  });
});

describe("DELETE a synced document (K11, 2026-10-13)", () => {
  it("★ a Drive/Confluence document kept in sync: 409 SYNCED_DOCUMENT pointing to the source, nothing deleted", async () => {
    H.deleted = [];
    H.docs[0].metadata.syncChangeKey = "2026-10-01T10:00:00Z";
    const r = await request(app).delete("/api/knowledge-bases/kb1/documents/d1");
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "SYNCED_DOCUMENT", sourceType: "google_drive", sourceUrl: "https://docs.google.com/document/d/abc/edit?usp=sharing" });
    expect(H.deleted).toEqual([]);
  });

  it("any other document is deleted as before", async () => {
    H.deleted = [];
    const r = await request(app).delete("/api/knowledge-bases/kb1/documents/d1");
    expect(r.status).toBe(200);
    expect(H.deleted).toEqual(["d1"]);
  });
});
