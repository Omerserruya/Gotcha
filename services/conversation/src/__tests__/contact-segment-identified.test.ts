/**
 * ★ POST /api/contacts/segment with `{ field: "identified" }` leaves out the
 * anonymous website visitor - a WEBCHAT or SHOPIFY_LIVE_CHAT contact with no
 * phone and no email - and nothing else; the total counts what the list
 * shows. Through the real route, with the `where` it builds evaluated over
 * rows by a small Prisma-shaped matcher (equals, in, null, OR, AND, NOT).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ contacts: [] as any[], wheres: [] as any[] }));

/** The subset of Prisma's filter language the segment route writes for these rules. */
function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([key, cond]: [string, any]) => {
    if (key === "AND") return (cond as any[]).every((w) => matches(row, w));
    if (key === "OR") return (cond as any[]).some((w) => matches(row, w));
    if (key === "NOT") return !matches(row, cond);
    const value = row[key] ?? null;
    if (cond === null) return value === null;
    if (typeof cond === "object" && "in" in cond) return (cond.in as unknown[]).includes(value);
    if (typeof cond === "object" && "contains" in cond) {
      return typeof value === "string" && value.toLowerCase().includes(String(cond.contains).toLowerCase());
    }
    return value === cond;
  });
}

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const pass = (_q: any, _s: any, n: any) => n();
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireActiveTenant: () => pass,
    requireRole: () => pass,
    requirePermissionOrRole: () => pass,
    prisma: {
      contact: {
        count: async (a: any) => { H.wheres.push(a.where); return H.contacts.filter((c) => matches(c, a.where)).length; },
        findMany: async (a: any) => { H.wheres.push(a.where); return H.contacts.filter((c) => matches(c, a.where)); },
      },
    },
  };
});

import router, { ANONYMOUS_VISITOR } from "../routes/contacts";
const app = express();
app.use(express.json());
app.use("/api/contacts", router);

const row = (id: string, channel: string, extra: Record<string, unknown> = {}) => ({
  id, tenantId: "T", mergedIntoId: null, channel, externalId: `x-${id}`,
  displayName: null, phone: null, email: null, tags: [], ...extra,
});

beforeEach(() => {
  H.wheres = [];
  H.contacts = [
    row("anon", "WEBCHAT"),
    row("anon-empty", "WEBCHAT", { phone: "", email: "" }),
    row("anon-named", "WEBCHAT", { displayName: "Dana" }),
    row("anon-shop", "SHOPIFY_LIVE_CHAT"),
    row("web-phone", "WEBCHAT", { phone: "972501234567" }),
    row("web-email", "WEBCHAT", { email: "dana@example.com" }),
    row("shop-email", "SHOPIFY_LIVE_CHAT", { email: "a@b.co" }),
    row("wa", "WHATSAPP", { phone: "972521111111" }),
    row("ig", "INSTAGRAM"),
    row("other-tenant", "WHATSAPP", { tenantId: "U" }),
    row("merged", "WHATSAPP", { mergedIntoId: "wa" }),
  ];
});

const ids = (body: any) => (body.data as any[]).map((c) => c.id).sort();

describe("★ the segment's `identified` rule", () => {
  it("leaves out only a website visitor with no phone and no email; a name alone is not one", async () => {
    const r = await request(app).post("/api/contacts/segment").send({ rules: [{ field: "identified" }] });
    expect(r.status).toBe(200);
    expect(ids(r.body)).toEqual(["ig", "shop-email", "wa", "web-email", "web-phone"]);
  });

  it("★ the total counts what the list shows: one `where` for both", async () => {
    const r = await request(app).post("/api/contacts/segment").send({ rules: [{ field: "identified" }] });
    expect(r.body.total).toBe(r.body.data.length);
    expect(H.wheres).toHaveLength(2);
    expect(H.wheres[0]).toEqual(H.wheres[1]);
    expect(H.wheres[0].AND).toContainEqual({ NOT: ANONYMOUS_VISITOR });
  });

  it("countOnly answers the same number", async () => {
    const r = await request(app).post("/api/contacts/segment").send({ rules: [{ field: "identified" }], countOnly: true });
    expect(r.body).toEqual({ data: [], total: 5 });
  });

  it("composes with a search rule", async () => {
    const r = await request(app).post("/api/contacts/segment").send({
      rules: [{ field: "name", operator: "contains", value: "dan" }, { field: "identified" }],
    });
    // Dana the anonymous visitor is the only Dana, and she is left out.
    expect(ids(r.body)).toEqual([]);
  });

  it("absent, or `value: false`: the list as before, visitors included", async () => {
    const before = await request(app).post("/api/contacts/segment").send({ rules: [] });
    expect(before.body.total).toBe(9);
    const off = await request(app).post("/api/contacts/segment").send({ rules: [{ field: "identified", value: false }] });
    expect(off.body.total).toBe(9);
  });
});
