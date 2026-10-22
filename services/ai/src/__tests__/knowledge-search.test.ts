/**
 * Searching Knowledge Center by what documents say (2026-10-14): title or
 * content contains the words, this workspace's only, Hebrew as English, with a
 * snippet around the match; title matches first.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ docs: [] as any[], where: null as any }));

const has = (v: unknown, q: string) => String(v ?? "").toLowerCase().includes(q.toLowerCase());
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const pass = (_q: any, _s: any, n: any) => n();
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireOnboardingOrActiveTenant: () => pass,
    requirePermissionOrRole: () => pass,
    requireEntitlement: () => pass,
    requireCapacity: () => pass,
    prisma: {
      knowledgeDocument: {
        // Reads the filter the route sends: a test fails if it stops scoping by tenant or field.
        findMany: async (a: any) => {
          H.where = a.where;
          const [t, c] = a.where.OR;
          return H.docs
            .filter((d) => d.tenantId === a.where.tenantId && (has(d.title, t.title.contains) || has(d.content, c.content.contains)))
            .sort((x, y) => y.updatedAt - x.updatedAt)
            .slice(0, a.take)
            .map((d) => ({ ...d, knowledgeBase: { name: "Company" } }));
        },
      },
    },
  };
});
vi.mock("../services/embedding.service", () => ({ processDocument: vi.fn() }));
vi.mock("../services/qdrant.service", () => ({ deleteByDocumentId: vi.fn(), deleteByKnowledgeBaseId: vi.fn() }));

import router, { snippetAround } from "../routes/knowledge";
const app = express();
app.use("/api/knowledge-bases", router);
const search = (q: string, extra = "") => request(app).get(`/api/knowledge-bases/search?q=${encodeURIComponent(q)}${extra}`);

const doc = (id: string, title: string, content: string, o: any = {}) => ({ id, tenantId: "T", knowledgeBaseId: "kb1", title, content, updatedAt: new Date(o.at ?? "2026-10-01"), ...o });

beforeEach(() => {
  H.docs = [
    doc("d1", "משלוחים, החזרות וביטולים", "משלוח חינם בהזמנה מעל 299 ש\"ח. החזרה בתוך 30 יום.", { at: "2026-10-10" }),
    doc("d2", "FAQ", "Do you ship to Eilat? Yes, shipping takes 2-4 days.", { at: "2026-10-12" }),
    doc("d3", "Shipping & Returns", "Free shipping over 299 within Israel.", { at: "2026-10-01" }),
    doc("theirs", "Shipping", "another workspace", { tenantId: "OTHER" }),
  ];
});

describe("GET /api/knowledge-bases/search", () => {
  it("★ title or content, this workspace only, title matches first", async () => {
    const r = await search("shipping");
    expect(r.status).toBe(200);
    expect(r.body.data.map((d: any) => [d.id, d.matchIn])).toEqual([["d3", "title"], ["d2", "content"]]);
    expect(H.where.tenantId).toBe("T");
    expect(H.where.OR).toEqual([{ title: { contains: "shipping", mode: "insensitive" } }, { content: { contains: "shipping", mode: "insensitive" } }]);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
  });

  it("★ Hebrew, with a snippet around the match", async () => {
    const r = await search("החזרה");
    expect(r.body.data).toEqual([expect.objectContaining({ id: "d1", matchIn: "content", knowledgeBaseName: "Company", snippet: expect.stringContaining("החזרה בתוך 30 יום") })]);
  });

  it("limit and hasMore", async () => {
    const r = await search("ship", "&limit=1");
    expect(r.body.data).toHaveLength(1);
    expect(r.body.hasMore).toBe(true);
  });

  it("too short or too long: 400 with a code", async () => {
    expect((await search("a")).body.code).toBe("QUERY_TOO_SHORT");
    expect((await search("x".repeat(201))).body).toMatchObject({ code: "QUERY_TOO_LONG", max: 200 });
  });
});

describe("snippetAround", () => {
  it("the words around the first match, marked where cut", () => {
    const text = "a ".repeat(100) + "THE MATCH" + " b".repeat(100);
    const s = snippetAround(text, "the match", 10)!;
    expect(s.startsWith("...")).toBe(true);
    expect(s.endsWith("...")).toBe(true);
    expect(s).toContain("THE MATCH");
    expect(snippetAround("short text", "short", 60)).toBe("short text");
    expect(snippetAround("nothing", "zzz")).toBeNull();
  });
});
