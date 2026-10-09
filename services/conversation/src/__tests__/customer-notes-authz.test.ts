/**
 * Customer notes are part of the contact record, so they take the contact
 * permission keys: crm:contacts:read to read, crm:contacts:update for every
 * write (create, edit, delete, accept/reject a suggestion). ADMIN keeps the
 * role fallback the neighbouring contact routes have.
 *
 * Until 2026-10-09 the router had only authenticate + tenant, so any member of
 * the tenant could read and write every customer's notes. Through the real
 * router; the permission double mirrors the real gate (permission first, then
 * the role fallback) and the prisma doubles honour the `where` they are given.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const S = vi.hoisted(() => ({
  user: { userId: "u1", role: "AGENT" } as { userId: string; role: string },
  granted: new Set<string>(),
  notes: [] as any[],
  seq: 0,
}));

function matches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
    if (k === "OR") return (v as any[]).some((w) => matches(row, w));
    if (k === "AND") return (v as any[]).every((w) => matches(row, w));
    if (v && typeof v === "object" && "in" in v) return v.in.includes(row[k]);
    return (row[k] ?? null) === v;
  });
}

vi.mock("@chatcenter/shared", () => ({
  prisma: {
    contact: { findFirst: async ({ where }: any) => (where.id === "c1" && where.tenantId === "t1" ? { id: "c1", mergedIntoId: null, personId: null } : null) },
    user: { findFirst: async ({ where }: any) => (where.tenantId ? { name: "Yael", email: "y@example.com" } : null) },
    customerNote: {
      findMany: async ({ where }: any) => S.notes.filter((n) => matches(n, where)).map((n) => ({ ...n })),
      findFirst: async ({ where }: any) => S.notes.find((n) => matches(n, where)) ?? null,
      create: async ({ data }: any) => {
        const row = { id: `n${++S.seq}`, deletedAt: null, createdAt: new Date(), ...data };
        S.notes.push(row);
        return { ...row };
      },
      update: async ({ where, data }: any) => {
        const row = S.notes.find((n) => n.id === where.id);
        Object.assign(row, data);
        return { ...row };
      },
    },
  },
  authenticate: (req: any, _r: any, n: any) => { req.user = { ...S.user }; n(); },
  resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "t1"; n(); },
  requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
  // Mirrors the real gate's contract: permission first, then role fallback.
  requirePermissionOrRole: (permission: string, ...roles: string[]) =>
    (req: any, res: any, next: any) => {
      if (S.granted.has(permission)) return next();
      if (req.user?.role === "SYSTEM_ADMIN" || roles.includes(req.user?.role)) return next();
      return res.status(403).json({ error: "Permission denied", code: "PERMISSION_DENIED", permissions: [permission] });
    },
}));

import notesRouter from "../routes/customer-notes";

const app = express();
app.use(express.json());
app.use("/api/identity", notesRouter);

const seedNote = (over: Record<string, unknown> = {}) => ({
  id: "n_seed", tenantId: "t1", contactId: "c1", personId: null, conversationId: null,
  body: "Prefers evening delivery", visibility: "TEAM", aiUsable: false, status: "PUBLISHED",
  authorUserId: "u1", authorName: "Yael", mentions: [], editHistory: [], deletedAt: null,
  createdAt: new Date(), ...over,
});

beforeEach(() => {
  S.user = { userId: "u1", role: "AGENT" };
  S.granted = new Set();
  S.seq = 0;
  S.notes = [seedNote(), seedNote({ id: "n_sugg", status: "AI_SUGGESTED", authorUserId: null })];
});

describe("customer notes: who may read", () => {
  it("★ a member without crm:contacts:read gets 403 and no note body", async () => {
    const r = await request(app).get("/api/identity/c1/notes");
    expect(r.status).toBe(403);
    expect(r.body.permissions).toEqual(["crm:contacts:read"]);
    expect(JSON.stringify(r.body)).not.toContain("evening");
  });

  it("with crm:contacts:read the notes are served", async () => {
    S.granted.add("crm:contacts:read");
    const r = await request(app).get("/api/identity/c1/notes");
    expect(r.status).toBe(200);
    expect(r.body.notes.map((n: any) => n.id)).toEqual(["n_seed"]);
  });

  it("an ADMIN with no explicit grant still reads them (role fallback)", async () => {
    S.user = { userId: "a1", role: "ADMIN" };
    const r = await request(app).get("/api/identity/c1/notes");
    expect(r.status).toBe(200);
    expect(r.body.notes).toHaveLength(1);
  });
});

describe("customer notes: who may write", () => {
  it("★ read alone does not write: POST is 403 and nothing is stored", async () => {
    S.granted.add("crm:contacts:read");
    const r = await request(app).post("/api/identity/c1/notes").send({ body: "new" });
    expect(r.status).toBe(403);
    expect(r.body.permissions).toEqual(["crm:contacts:update"]);
    expect(S.notes).toHaveLength(2);
  });

  it("★ read alone does not edit or delete, even the reader's own note", async () => {
    S.granted.add("crm:contacts:read");
    const edit = await request(app).patch("/api/identity/c1/notes/n_seed").send({ body: "rewritten" });
    const del = await request(app).delete("/api/identity/c1/notes/n_seed");
    expect([edit.status, del.status]).toEqual([403, 403]);
    const row = S.notes.find((n) => n.id === "n_seed");
    expect(row.body).toBe("Prefers evening delivery");
    expect(row.deletedAt).toBeNull();
  });

  it("★ read alone does not accept or reject an AI suggestion", async () => {
    S.granted.add("crm:contacts:read");
    const acc = await request(app).post("/api/identity/c1/notes/n_sugg/accept");
    const rej = await request(app).post("/api/identity/c1/notes/n_sugg/reject");
    expect([acc.status, rej.status]).toEqual([403, 403]);
    expect(S.notes.find((n) => n.id === "n_sugg").status).toBe("AI_SUGGESTED");
  });

  it("with crm:contacts:update every write goes through", async () => {
    S.granted.add("crm:contacts:update");
    expect((await request(app).post("/api/identity/c1/notes").send({ body: "new" })).status).toBe(201);
    expect((await request(app).patch("/api/identity/c1/notes/n_seed").send({ body: "rewritten" })).status).toBe(200);
    expect((await request(app).post("/api/identity/c1/notes/n_sugg/reject")).status).toBe(200);
    expect((await request(app).delete("/api/identity/c1/notes/n_seed")).status).toBe(200);
    expect(S.notes.find((n) => n.id === "n_seed").deletedAt).not.toBeNull();
  });

  it("an ADMIN with no explicit grant still writes (role fallback)", async () => {
    S.user = { userId: "a1", role: "ADMIN" };
    expect((await request(app).post("/api/identity/c1/notes").send({ body: "new" })).status).toBe(201);
  });
});
