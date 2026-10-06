/**
 * PUT /api/permissions/users/:userId/grants/:feature takes an end date (12e),
 * and the reads return it with `active`. Through the REAL router.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const DB = vi.hoisted(() => ({ grants: [] as any[], audits: [] as any[] }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "admin1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireRole: () => (_q: any, _s: any, n: any) => n(),
    assertTenantId: (req: any) => req.tenantId,
    writeAudit: async (a: any) => { DB.audits.push(a); },
    invalidatePermissionsCache: () => {},
    prisma: {
      user: { findFirst: async (a: any) => (a.where.id === "u1" && a.where.tenantId === "T" ? { id: "u1" } : null) },
      userFeatureGrant: {
        findMany: async (a: any) => DB.grants.filter((g) => g.userId === a.where.userId),
        upsert: async (a: any) => {
          const k = a.where.userId_feature;
          const i = DB.grants.findIndex((g) => g.userId === k.userId && g.feature === k.feature);
          const row = i >= 0 ? { ...DB.grants[i], ...a.update } : { id: "g1", ...a.create };
          if (i >= 0) DB.grants[i] = row; else DB.grants.push(row);
          return row;
        },
      },
    },
  };
});

import router from "../routes/permissions";

const app = express();
app.use(express.json());
app.use("/api/permissions", router);
const put = (body: any) => request(app).put("/api/permissions/users/u1/grants/auto_buy").send(body);

beforeEach(() => { DB.grants = []; DB.audits = []; });

describe("grant end date", () => {
  it("★ stores expiresAt, returns it with active:true, and audits the end date", async () => {
    const end = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const r = await put({ granted: true, expiresAt: end });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ granted: true, active: true });
    expect(new Date(r.body.data.expiresAt).toISOString()).toBe(end);
    expect(DB.audits[0].metadata).toEqual({ feature: "auto_buy", granted: true, expiresAt: end });
  });

  it("★ no expiresAt = no end date, and re-saving without it CLEARS an end date", async () => {
    await put({ granted: true, expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    const r = await put({ granted: true });
    expect(r.body.data).toMatchObject({ expiresAt: null, active: true });
  });

  it("refuses a date in the past (a save that would never apply)", async () => {
    const r = await put({ granted: true, expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("EXPIRES_IN_PAST");
    expect(DB.grants).toHaveLength(0);
  });

  it("refuses a value that is not a date", async () => {
    expect((await put({ granted: true, expiresAt: "next week" })).status).toBe(400);
  });

  it("★ GET lists an expired grant with active:false (the resolver ignores it)", async () => {
    DB.grants = [{ id: "g1", userId: "u1", feature: "auto_buy", granted: true, expiresAt: new Date(Date.now() - 1000) }];
    const r = await request(app).get("/api/permissions/users/u1/grants");
    expect(r.body.data[0]).toMatchObject({ feature: "auto_buy", active: false });
  });
});
