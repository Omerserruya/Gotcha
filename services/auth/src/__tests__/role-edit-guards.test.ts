/**
 * ★ Two holes in role editing (design 12, found by Frontend):
 *   - PUT /roles/:id/features rewrote a built-in role's capabilities (PATCH
 *     and DELETE refused system roles; this did not): 403 SYSTEM_ROLE
 *   - PATCH /roles/:id with a name the workspace already uses was a 500:
 *     409 ROLE_NAME_TAKEN
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const DB = vi.hoisted(() => ({ roles: [] as any[], features: [] as any[], writes: 0 }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "a1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireRole: () => (_q: any, _s: any, n: any) => n(),
    assertTenantId: (req: any) => req.tenantId,
    writeAudit: async () => undefined,
    invalidatePermissionsCache: () => {},
    prisma: {
      tenantRole: {
        findFirst: async (a: any) => DB.roles.find((r) => r.id === a.where.id && r.tenantId === a.where.tenantId) ?? null,
        findUnique: async (a: any) => ({ ...DB.roles.find((r) => r.id === a.where.id), features: DB.features.filter((f) => f.roleId === a.where.id) }),
        update: async (a: any) => {
          const r = DB.roles.find((x) => x.id === a.where.id);
          if (a.data.name && DB.roles.some((x) => x.tenantId === r.tenantId && x.id !== r.id && x.name === a.data.name)) throw Object.assign(new Error("Unique constraint"), { code: "P2002" });
          DB.writes++;
          return Object.assign(r, a.data);
        },
      },
      tenantRoleFeature: {
        // The route reads the role's set first: the audit's before image.
        findMany: async (a: any) => DB.features.filter((f) => f.roleId === a.where.roleId).map((f) => ({ feature: f.feature })),
        deleteMany: (a: any) => ({ op: "delete", a }),
        createMany: (a: any) => ({ op: "create", a }),
      },
      $transaction: async (ops: any[]) => {
        for (const o of ops) {
          DB.writes++;
          if (o.op === "delete") DB.features = DB.features.filter((f) => f.roleId !== o.a.where.roleId);
          else DB.features.push(...o.a.data);
        }
      },
    },
  };
});

// lib/grant-ceiling (2026-10-11) refuses granting above one's own role. This
// file tests a different guard, so the ceiling never refuses here; it has its
// own tests (grant-ceiling-routes.test.ts).
vi.mock("../lib/grant-ceiling", () => ({
  actorOf: (req: any) => ({ userId: req.user?.userId, tenantId: req.tenantId, role: req.user?.role }),
  patternsRefusal: async () => null,
  roleRefusal: async () => null,
  targetRefusal: async () => null,
  inviteRoleRefusal: async () => null,
}));

import router from "../routes/permissions";

const app = express();
app.use(express.json());
app.use("/api/permissions", router);

beforeEach(() => {
  DB.writes = 0;
  DB.roles = [
    { id: "r_admin", tenantId: "T", name: "Admin", isSystem: true },
    { id: "r_sales", tenantId: "T", name: "Sales", isSystem: false },
    { id: "r_support", tenantId: "T", name: "Support", isSystem: false },
  ];
  DB.features = [{ roleId: "r_admin", feature: "conversation:messages:read" }];
});

describe("★ a built-in role's capabilities cannot be rewritten", () => {
  it("PUT /roles/:id/features on a system role: 403 SYSTEM_ROLE, nothing written", async () => {
    const r = await request(app).put("/api/permissions/roles/r_admin/features").send({ features: [] });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("SYSTEM_ROLE");
    expect(DB.writes).toBe(0);
    expect(DB.features).toEqual([{ roleId: "r_admin", feature: "conversation:messages:read" }]);
  });

  it("a workspace's own role still can", async () => {
    const r = await request(app).put("/api/permissions/roles/r_sales/features").send({ features: ["conversation:messages:read"] });
    expect(r.status).toBe(200);
    expect(DB.features.filter((f) => f.roleId === "r_sales")).toHaveLength(1);
  });

  it("PATCH and DELETE say the same code", async () => {
    expect((await request(app).patch("/api/permissions/roles/r_admin").send({ name: "Boss" })).body.code).toBe("SYSTEM_ROLE");
  });
});

describe("★ a role name the workspace already uses", () => {
  it("PATCH: 409 ROLE_NAME_TAKEN, not a 500", async () => {
    const r = await request(app).patch("/api/permissions/roles/r_sales").send({ name: "Support" });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("ROLE_NAME_TAKEN");
    expect(DB.roles.find((x) => x.id === "r_sales").name).toBe("Sales");
  });

  it("a free name is renamed", async () => {
    const r = await request(app).patch("/api/permissions/roles/r_sales").send({ name: "Sales team" });
    expect(r.status).toBe(200);
    expect(r.body.data.name).toBe("Sales team");
  });
});
