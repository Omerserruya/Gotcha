/**
 * ★ "These two are not the same person" (design 04), through the real routes:
 *   - marking needs crm:contacts:update (or ADMIN); reading, crm:contacts:read
 *   - both customers must be this workspace's (404 otherwise); two linked as
 *     one person cannot be marked apart (409); two different ids required
 *   - idempotent: the pair once, in either order, keeping the first mark
 *   - the list tells v2 which pairs never to suggest again
 *   - merging the pair later still works and clears the mark
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

function match(row: any, w: any): boolean {
  return Object.entries(w ?? {}).every(([k, v]: [string, any]) => {
    if (k === "OR") return v.some((x: any) => match(row, x));
    if (v && typeof v === "object") {
      if ("in" in v) return v.in.includes(row[k]);
      if ("startsWith" in v) return String(row[k]).startsWith(v.startsWith);
      if ("endsWith" in v) return String(row[k]).endsWith(v.endsWith);
      if ("contains" in v) return String(row[k]).includes(v.contains);
      return true;
    }
    return (row[k] ?? null) === v;
  });
}
const H = vi.hoisted(() => ({ contacts: [] as any[], settings: [] as any[], perms: ["crm:contacts:read", "crm:contacts:update"] as string[], user: { userId: "u1", role: "AGENT" } }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const tx = {
    broadcastRecipient: { updateMany: async () => ({ count: 0 }) },
    contact: { update: async (a: any) => { const c = H.contacts.find((x) => x.id === a.where.id); Object.assign(c, a.data); return c; } },
  };
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { ...H.user, tenantId: "T" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requirePermissionOrRole: (perm: string, role: string) => (req: any, res: any, n: any) =>
      H.perms.includes(perm) || req.user.role === role ? n() : res.status(403).json({ error: "Forbidden" }),
    prisma: {
      contact: {
        findMany: async (a: any) => H.contacts.filter((c) => match(c, a.where)),
        findFirst: async (a: any) => H.contacts.find((c) => c.id === a.where.id && c.tenantId === a.where.tenantId) ?? null,
      },
      tenantSetting: {
        findMany: async (a: any) => H.settings.filter((s) => match(s, a.where)),
        upsert: async (a: any) => {
          const k = a.where.tenantId_key;
          const found = H.settings.find((s) => s.tenantId === k.tenantId && s.key === k.key);
          if (found) return Object.assign(found, a.update);
          const row = { ...a.create }; H.settings.push(row); return row;
        },
        deleteMany: async (a: any) => { const before = H.settings.length; H.settings = H.settings.filter((s) => !match(s, a.where)); return { count: before - H.settings.length }; },
      },
      $transaction: async (fn: any) => fn(tx),
    },
  };
});

import router from "../routes/identity";

const app = express();
app.use(express.json());
app.use("/api/identity", router);
const mark = (contactIds: any) => request(app).post("/api/identity/not-same").send({ contactIds });

beforeEach(() => {
  H.perms = ["crm:contacts:read", "crm:contacts:update"];
  H.user = { userId: "u1", role: "AGENT" };
  H.settings = [];
  const c = (id: string, o: any = {}) => ({ id, tenantId: "T", channel: "WHATSAPP", externalId: id, personId: null, mergedIntoId: null, metadata: {}, tags: [], email: null, phone: null, displayName: id, avatarUrl: null, lastInteractionAt: null, ...o });
  H.contacts = [c("dana1"), c("dana2"), c("dana3"), c("linked1", { personId: "p1" }), c("linked2", { personId: "p1" }), c("theirs", { tenantId: "OTHER" })];
});

describe("★ marking two customers as different people", () => {
  it("marks the pair, once, in either order; the list returns it", async () => {
    const r = await mark(["dana2", "dana1"]);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ contactIds: ["dana1", "dana2"], markedBy: "u1" });
    const first = r.body.data.markedAt;
    H.user = { userId: "u2", role: "AGENT" };
    const again = await mark(["dana1", "dana2"]);
    expect(again.body.data).toMatchObject({ markedAt: first, markedBy: "u1" });
    expect(H.settings).toHaveLength(1);
    expect(H.settings[0].key).toBe("identity:not-same:dana1:dana2");
    expect((await request(app).get("/api/identity/not-same")).body.data).toEqual([{ contactIds: ["dana1", "dana2"], markedAt: first, markedBy: "u1" }]);
  });

  it("another workspace's customer: 404; not two different ids: 400; already one person: 409; nothing written", async () => {
    expect((await mark(["dana1", "theirs"])).body.code).toBe("CONTACT_NOT_FOUND");
    expect((await mark(["dana1", "dana1"])).status).toBe(400);
    expect((await mark(["dana1"])).status).toBe(400);
    expect((await mark(["linked1", "linked2"])).body.code).toBe("ALREADY_SAME_PERSON");
    expect(H.settings).toEqual([]);
  });

  it("★ marking needs crm:contacts:update; reading needs crm:contacts:read (ADMIN passes both)", async () => {
    H.perms = ["crm:contacts:read"];
    expect((await mark(["dana1", "dana2"])).status).toBe(403);
    expect((await request(app).get("/api/identity/not-same")).status).toBe(200);
    H.perms = [];
    expect((await request(app).get("/api/identity/not-same")).status).toBe(403);
    H.user = { userId: "boss", role: "ADMIN" };
    expect((await mark(["dana1", "dana2"])).status).toBe(200);
    expect(H.settings).toHaveLength(1);
  });

  it("merging the pair later still works, and clears the mark", async () => {
    await mark(["dana1", "dana2"]);
    const r = await request(app).post("/api/identity/merge").send({ targetId: "dana1", sourceId: "dana2" });
    expect(r.body.merged).toBe(true);
    expect(H.settings).toEqual([]);
  });
});

describe("★ a mark never outlives its customers", () => {
  it("merged into a third customer: the merged-away one's marks go; the pair's own mark goes", async () => {
    await mark(["dana1", "dana2"]);
    await mark(["dana2", "dana3"]);
    await mark(["dana1", "dana3"]);
    // dana2 merged into a third (linked1): its marks name a customer that no longer stands alone.
    const r = await request(app).post("/api/identity/merge").send({ targetId: "linked1", sourceId: "dana2" });
    expect(r.body.merged).toBe(true);
    expect(H.settings.map((s) => s.key)).toEqual(["identity:not-same:dana1:dana3"]);
  });

  it("the list returns only pairs whose two customers still exist unmerged, and drops the others", async () => {
    await mark(["dana1", "dana2"]);
    await mark(["dana1", "dana3"]);
    // Erased outside these routes, and merged away by a path that left the mark.
    H.contacts = H.contacts.filter((c) => c.id !== "dana2");
    H.contacts.find((c) => c.id === "dana3").mergedIntoId = "linked1";
    const list = await request(app).get("/api/identity/not-same");
    expect(list.body.data).toEqual([]);
    expect(H.settings).toEqual([]);
  });
});
