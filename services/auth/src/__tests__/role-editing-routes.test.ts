/**
 * ★ Built-in roles are editable within their ceilings (Omer, 2026-10-11),
 * through the real /api/permissions routes. The grant ceiling (who may grant
 * what) has its own tests and is a pass-through here; this file is about
 * what a ROLE may hold.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ roles: [] as any[], settings: [] as any[], audits: [] as any[], counts: {} as Record<string, number> }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "owner1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireRole: () => (_q: any, _s: any, n: any) => n(),
    assertTenantId: (req: any) => req.tenantId,
    writeAudit: async (a: any) => { H.audits.push(a); },
    invalidatePermissionsCache: () => {},
    prisma: {
      tenantRole: {
        findFirst: async (a: any) => H.roles.find((r) => r.id === a.where.id && r.tenantId === a.where.tenantId) ?? null,
        findMany: async () => H.roles.map((r) => ({ ...r, features: r.features.map((feature: string) => ({ roleId: r.id, feature })), _count: { assignments: H.counts[r.id] ?? 0 } })),
        findUnique: async (a: any) => { const r = H.roles.find((x) => x.id === a.where.id); return { ...r, features: r.features.map((feature: string) => ({ feature })) }; },
      },
      tenantRoleFeature: {
        findMany: async (a: any) => H.roles.find((r) => r.id === a.where.roleId).features.map((feature: string) => ({ feature })),
        deleteMany: (a: any) => ({ op: "del", roleId: a.where.roleId }),
        createMany: (a: any) => ({ op: "add", data: a.data }),
      },
      tenantSetting: {
        findMany: async (a: any) => H.settings.filter((s) => s.tenantId === a.where.tenantId && s.key.startsWith(a.where.key.startsWith)),
        upsert: async (a: any) => { if (!H.settings.some((s) => s.key === a.where.tenantId_key.key)) H.settings.push({ ...a.create }); return a.create; },
        deleteMany: (a: any) => ({ op: "unmark", key: a.where.key }),
      },
      user: { findFirst: async () => ({ id: "agent1", tenantId: "T", role: "AGENT" }) },
      $transaction: async (ops: any[]) => {
        for (const o of ops) {
          if (o.op === "del") H.roles.find((r) => r.id === o.roleId).features = [];
          if (o.op === "add") for (const d of o.data) H.roles.find((r) => r.id === d.roleId).features.push(d.feature);
          if (o.op === "unmark") H.settings = H.settings.filter((s) => s.key !== o.key);
        }
      },
    },
  };
});
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
  H.roles = [
    { id: "r_owner", tenantId: "T", name: "Owner", isSystem: true, builtinKey: "owner", features: ["*"] },
    { id: "r_admin", tenantId: "T", name: "Admin", isSystem: true, builtinKey: "admin", features: ["conversation:messages:read"] },
    { id: "r_dm", tenantId: "T", name: "Department Manager", isSystem: true, builtinKey: "department_manager", features: ["conversation:messages:*"] },
    { id: "r_agent", tenantId: "T", name: "Agent", isSystem: true, builtinKey: "agent", features: ["conversation:messages:read"] },
    { id: "r_sales", tenantId: "T", name: "Sales", isSystem: false, builtinKey: null, features: [] },
  ];
  H.settings = []; H.audits = []; H.counts = {};
});
afterEach(() => { delete process.env.ROLES_EDITABLE; });

const put = (id: string, features: string[]) => request(app).put(`/api/permissions/roles/${id}/features`).send({ features });

describe("★ editing a built-in role", () => {
  it("an Agent can be given more, within the ceiling: saved, marked customized, audited before and after", async () => {
    const r = await put("r_agent", ["conversation:messages:read", "analytics:dashboard:read"]);
    expect(r.status).toBe(200);
    expect(H.roles.find((x) => x.id === "r_agent").features).toEqual(["conversation:messages:read", "analytics:dashboard:read"]);
    expect(H.settings.map((s) => s.key)).toEqual(["rbac:customized:r_agent"]);
    expect(H.audits[0].metadata).toMatchObject({ before: ["conversation:messages:read"], added: ["analytics:dashboard:read"] });
  });

  it("never past the ceiling: 403 ROLE_CEILING naming the blocked keys, even through a wildcard", async () => {
    const r = await put("r_agent", ["conversation:messages:read", "settings:billing:*"]);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("ROLE_CEILING");
    expect(r.body.blocked).toContain("settings:billing:manage");
    const star = await put("r_dm", ["*"]);
    expect(star.body.blocked).toContain("settings:members:manage");
    expect(H.settings).toHaveLength(0);
  });

  it("the Owner never below its floor: 422 OWNER_FLOOR", async () => {
    const r = await put("r_owner", ["conversation:messages:*", "settings:roles:manage"]);
    expect(r.status).toBe(422);
    expect(r.body.missing).toEqual(["settings:members:manage", "settings:billing:manage"]);
  });

  it("the merged Admin role: 409 ROLE_MERGED; and with ROLES_EDITABLE=false, the old 403", async () => {
    expect((await put("r_admin", [])).body.code).toBe("ROLE_MERGED");
    process.env.ROLES_EDITABLE = "false";
    expect((await put("r_agent", ["conversation:messages:read"])).body.code).toBe("SYSTEM_ROLE");
  });

  it("reset to default: the catalog's set, the marker removed, audited", async () => {
    await put("r_agent", ["conversation:messages:read", "analytics:dashboard:read"]);
    const r = await request(app).post("/api/permissions/roles/r_agent/reset");
    expect(r.status).toBe(200);
    expect(H.roles.find((x) => x.id === "r_agent").features).not.toContain("analytics:dashboard:read");
    expect(H.roles.find((x) => x.id === "r_agent").features).toContain("conversation:messages:reply");
    expect(H.settings).toHaveLength(0);
    expect(H.audits.at(-1).metadata.change).toBe("reset");
    expect((await request(app).post("/api/permissions/roles/r_sales/reset")).body.code).toBe("NOT_BUILTIN");
  });

  it("assigning the merged Admin role: 409 ROLE_MERGED", async () => {
    expect((await request(app).post("/api/permissions/users/agent1/roles/r_admin")).body.code).toBe("ROLE_MERGED");
    expect((await request(app).put("/api/permissions/users/agent1/role").send({ roleId: "r_admin" })).body.code).toBe("ROLE_MERGED");
  });
});

describe("★ GET /roles: what the grid needs", () => {
  it("each role says what it can never hold, its floor, whether it is editable, customized, and its defaults", async () => {
    H.settings.push({ tenantId: "T", key: "rbac:customized:r_dm", value: {} });
    const r = await request(app).get("/api/permissions/roles");
    const by = Object.fromEntries(r.body.data.map((x: any) => [x.id, x]));
    expect(by.r_agent.ceiling).toContain("settings:billing:manage");
    expect(by.r_agent.ceiling).toContain("analytics:workspace:read");
    expect(by.r_agent.ceiling).not.toContain("analytics:dashboard:read");
    expect(by.r_dm.ceiling).toContain("settings:members:manage");
    expect(by.r_dm.customized).toBe(true);
    expect(by.r_owner).toMatchObject({ ceiling: [], floor: ["settings:roles:manage", "settings:members:manage", "settings:billing:manage"], editable: true });
    expect(by.r_sales).toMatchObject({ ceiling: [], editable: true, defaults: null });
    expect(by.r_admin).toBeUndefined(); // merged, nobody holds it
  });

  it("the merged Admin still shows while someone holds it (until the merge script runs)", async () => {
    H.counts.r_admin = 2;
    const r = await request(app).get("/api/permissions/roles");
    expect(r.body.data.find((x: any) => x.id === "r_admin")).toMatchObject({ editable: false });
  });
});
