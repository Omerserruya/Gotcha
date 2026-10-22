/**
 * ★ Nobody hands out more than they hold (2026-10-11), through the real routes.
 *
 * An Admin (who lacks the Owner-only billing and roles keys) used to be able to:
 * create a custom role holding "*", grant anyone any key, make anyone (or
 * themselves) Owner, change an Owner's roles, and invite into any role. Each
 * door is tried here with the real lib/grant-ceiling; only the permission
 * lookups are doubled - as the actor's held set, which is the thing the rule
 * compares against.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const OWNER_ONLY = ["settings:billing:manage", "settings:billing:cancel", "settings:billing:purchase", "settings:billing:auto-purchase", "settings:roles:manage"];

const H = vi.hoisted(() => ({
  actor: { userId: "admin1", role: "ADMIN" } as any,
  builtin: {} as Record<string, string>,
  held: new Set<string>(),
  roles: [] as any[],
  users: [] as any[],
  assignments: [] as any[],
  grants: [] as any[],
  audits: [] as any[],
  invites: [] as any[],
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const tx = () => ({
    userRoleAssignment: {
      upsert: async (a: any) => { H.assignments.push({ userId: a.create.userId, roleId: a.create.roleId }); return a.create; },
      deleteMany: async (a: any) => { H.assignments = H.assignments.filter((x) => !(x.userId === a.where.userId && (!a.where.roleId || x.roleId === a.where.roleId))); return { count: 1 }; },
      create: async (a: any) => { H.assignments.push({ userId: a.data.userId, roleId: a.data.roleId }); return a.data; },
    },
  });
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = H.actor; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireRole: () => (_q: any, _s: any, n: any) => n(),
    requirePermissionOrRole: () => (_q: any, _s: any, n: any) => n(),
    requireCapacity: () => (_q: any, _s: any, n: any) => n(),
    enforceMfaEnrollment: () => (_q: any, _s: any, n: any) => n(),
    assertTenantId: (req: any) => req.tenantId,
    writeAudit: async (a: any) => { H.audits.push(a); },
    invalidatePermissionsCache: () => {},
    hasPermission: async (u: any, key: string) => u.role === "SYSTEM_ADMIN" || (H.builtin[u.userId] === "owner") || H.held.has(key),
    hasFeature: async () => true,
    getEffectiveBuiltinRole: async (u: any) => H.builtin[u.userId] ?? null,
    prisma: {
      tenantRole: {
        findFirst: async (a: any) => {
          const r = H.roles.find((x) => x.tenantId === a.where.tenantId && (a.where.id ? x.id === a.where.id : x.builtinKey === a.where.builtinKey));
          return r ? { ...r, features: r.features.map((feature: string) => ({ feature })) } : null;
        },
        create: async (a: any) => { const r = { id: `r_${H.roles.length}`, tenantId: a.data.tenantId, name: a.data.name, isSystem: false, builtinKey: null, features: a.data.features.create.map((f: any) => f.feature) }; H.roles.push(r); return r; },
        findUnique: async (a: any) => H.roles.find((x) => x.id === a.where.id) ?? null,
      },
      tenantRoleFeature: {
        findMany: async (a: any) => (H.roles.find((x) => x.id === a.where.roleId)?.features ?? []).map((feature: string) => ({ feature })),
        deleteMany: (a: any) => ({ op: "delete", roleId: a.where.roleId }),
        createMany: (a: any) => ({ op: "create", data: a.data }),
      },
      $transaction: async (ops: any) => {
        if (typeof ops === "function") return ops(tx());
        for (const o of ops) {
          const r = H.roles.find((x) => x.id === (o.roleId ?? o.data?.[0]?.roleId));
          if (o.op === "delete" && r) r.features = [];
          if (o.op === "create") for (const d of o.data) H.roles.find((x) => x.id === d.roleId)?.features.push(d.feature);
        }
      },
      user: { findFirst: async (a: any) => H.users.find((u) => u.id === a.where.id && u.tenantId === a.where.tenantId) ?? null },
      userFeatureGrant: { upsert: async (a: any) => { H.grants.push(a.create); return { ...a.create, expiresAt: null }; }, deleteMany: async () => ({ count: 1 }) },
      userRoleAssignment: { ...tx().userRoleAssignment, findFirst: async (a: any) => ({ userId: a.where.userId, roleId: a.where.roleId, role: { builtinKey: H.roles.find((r) => r.id === a.where.roleId)?.builtinKey ?? null } }) },
      department: { findMany: async () => [] },
      departmentMember: { createMany: async () => ({ count: 0 }) },
    },
  };
});
vi.mock("../services/role-guard", () => ({
  changeRoles: async (o: any) => o.change({
    userRoleAssignment: {
      upsert: async (a: any) => { H.assignments.push({ userId: a.create.userId, roleId: a.create.roleId }); },
      deleteMany: async (a: any) => { H.assignments = H.assignments.filter((x) => !(x.userId === a.where.userId && (!a.where.roleId || x.roleId === a.where.roleId))); },
      create: async (a: any) => { H.assignments.push({ userId: a.data.userId, roleId: a.data.roleId }); },
    },
  }),
  RoleChangeRefused: class extends Error {},
}));
vi.mock("../services/invitation.service", () => ({
  inviteUser: async (tenantId: string, email: string, name: string, role: string) => { H.invites.push({ email, role }); return { user: { id: `u_${email}` } }; },
}));

import permissions from "../routes/permissions";
import agents from "../routes/agents";
const app = express();
app.use(express.json());
app.use("/api/permissions", permissions);
app.use("/api/agents", agents);

beforeEach(() => {
  H.actor = { userId: "admin1", role: "ADMIN" };
  H.builtin = { admin1: "admin", owner1: "owner", agent1: "agent" };
  // An Admin holds every key except the Owner-only ones.
  H.held = new Set(["conversation:messages:read", "conversation:messages:reply", "settings:members:manage", "settings:workspace:read"]);
  H.roles = [
    { id: "r_owner", tenantId: "T", name: "Owner", isSystem: true, builtinKey: "owner", features: ["*"] },
    { id: "r_admin", tenantId: "T", name: "Admin", isSystem: true, builtinKey: "admin", features: ["conversation:messages:read", "settings:members:manage"] },
    { id: "r_agent", tenantId: "T", name: "Agent", isSystem: true, builtinKey: "agent", features: ["conversation:messages:read"] },
    { id: "r_sales", tenantId: "T", name: "Sales", isSystem: false, builtinKey: null, features: ["conversation:messages:read"] },
    { id: "r_billing", tenantId: "T", name: "Billing helper", isSystem: false, builtinKey: null, features: ["settings:billing:manage"] },
  ];
  H.users = [
    { id: "owner1", tenantId: "T", role: "ADMIN" },
    { id: "admin1", tenantId: "T", role: "ADMIN" },
    { id: "agent1", tenantId: "T", role: "AGENT" },
  ];
  H.assignments = []; H.grants = []; H.audits = []; H.invites = [];
});

describe("★ an Admin cannot hand out what they do not hold", () => {
  it("a custom role holding \"*\": 403 ABOVE_OWN_ROLE, naming the Owner-only keys; nothing created", async () => {
    const r = await request(app).post("/api/permissions/roles").send({ name: "Super", features: ["*"] });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("ABOVE_OWN_ROLE");
    for (const k of OWNER_ONLY) expect(r.body.missing).toContain(k);
    expect(H.roles.some((x) => x.name === "Super")).toBe(false);
  });

  it("a custom role within their own set is still fine", async () => {
    const r = await request(app).post("/api/permissions/roles").send({ name: "Support", features: ["conversation:messages:read", "conversation:messages:reply"] });
    expect(r.status).toBe(201);
  });

  it("adding a billing key to a role's set: refused, the set untouched", async () => {
    const r = await request(app).put("/api/permissions/roles/r_sales/features").send({ features: ["conversation:messages:read", "settings:billing:manage"] });
    expect(r.status).toBe(403);
    expect(H.roles.find((x) => x.id === "r_sales").features).toEqual(["conversation:messages:read"]);
  });

  it("granting a user a key the Admin lacks: refused; a key they hold: fine", async () => {
    expect((await request(app).put("/api/permissions/users/agent1/grants/settings:billing:manage").send({ granted: true })).status).toBe(403);
    expect(H.grants).toHaveLength(0);
    expect((await request(app).put("/api/permissions/users/agent1/grants/conversation:messages:reply").send({ granted: true })).status).toBe(200);
  });

  it("making someone (or themselves) Owner: 403 OWNER_ONLY, by every assignment route", async () => {
    for (const call of [
      () => request(app).post("/api/permissions/users/agent1/roles/r_owner"),
      () => request(app).put("/api/permissions/users/agent1/role").send({ roleId: "r_owner" }),
      () => request(app).put("/api/permissions/users/admin1/role").send({ roleId: "r_owner" }),
    ]) {
      const r = await call();
      expect(r.status).toBe(403);
      expect(r.body.code).toBe("OWNER_ONLY");
    }
    expect(H.assignments).toHaveLength(0);
  });

  it("assigning a custom role that holds a billing key: refused", async () => {
    const r = await request(app).post("/api/permissions/users/agent1/roles/r_billing");
    expect(r.status).toBe(403);
    expect(r.body.missing).toEqual(["settings:billing:manage"]);
  });

  it("changing an Owner's roles (demote, remove, revoke): OWNER_ONLY", async () => {
    expect((await request(app).put("/api/permissions/users/owner1/role").send({ roleId: "r_agent" })).body.code).toBe("OWNER_ONLY");
    expect((await request(app).delete("/api/permissions/users/owner1/roles/r_owner")).body.code).toBe("OWNER_ONLY");
    expect((await request(app).put("/api/permissions/users/owner1/grants/conversation:messages:read").send({ granted: false })).body.code).toBe("OWNER_ONLY");
  });

  it("an Owner can do all of it", async () => {
    H.actor = { userId: "owner1", role: "ADMIN" };
    expect((await request(app).post("/api/permissions/roles").send({ name: "Super", features: ["*"] })).status).toBe(201);
    expect((await request(app).post("/api/permissions/users/agent1/roles/r_owner")).status).toBe(201);
  });
});

describe("★ invites (G5): into a chosen role, never above the inviter's", () => {
  it("POST /api/agents with a role: invited with its coarse role, assigned it, audited with it", async () => {
    const r = await request(app).post("/api/agents").send({ email: "dana@example.com", name: "Dana", role: "r_sales" });
    expect(r.status).toBe(201);
    expect(H.invites).toEqual([{ email: "dana@example.com", role: "AGENT" }]);
    expect(H.assignments).toEqual([{ userId: "u_dana@example.com", roleId: "r_sales" }]);
    expect(H.audits.find((a) => a.action === "invite.created" || a.action === "INVITE_CREATED" || /invite/i.test(a.action))?.metadata).toMatchObject({ role: "AGENT", roleId: "r_sales", roleName: "Sales" });
  });

  it("no role: agent, exactly as before", async () => {
    await request(app).post("/api/agents").send({ email: "eli@example.com", name: "Eli" });
    expect(H.invites).toEqual([{ email: "eli@example.com", role: "AGENT" }]);
    expect(H.assignments).toEqual([{ userId: "u_eli@example.com", roleId: "r_agent" }]);
  });

  it("an Admin inviting an Owner, or into a billing role: 403, nobody invited", async () => {
    expect((await request(app).post("/api/agents").send({ email: "x@example.com", name: "X", role: "r_owner" })).body.code).toBe("OWNER_ONLY");
    expect((await request(app).post("/api/agents").send({ email: "y@example.com", name: "Y", role: "r_billing" })).body.code).toBe("ABOVE_OWN_ROLE");
    expect(H.invites).toHaveLength(0);
  });

  it("the \"ADMIN\" keyword (and the merged Admin role's id) now means Owner: an Admin gets OWNER_ONLY", async () => {
    H.roles.push({ id: "r_old_admin", tenantId: "T", name: "Admin", isSystem: true, builtinKey: "admin", features: [] });
    expect((await request(app).post("/api/agents").send({ email: "k@example.com", name: "K", role: "ADMIN" })).body.code).toBe("OWNER_ONLY");
    expect((await request(app).post("/api/agents").send({ email: "l@example.com", name: "L", role: "r_old_admin" })).body.code).toBe("OWNER_ONLY");
    expect(H.invites).toHaveLength(0);
  });

  it("a role from another workspace, or no such role: 400, nobody invited", async () => {
    H.roles.push({ id: "r_other", tenantId: "OTHER", name: "Other", isSystem: false, builtinKey: null, features: [] });
    expect((await request(app).post("/api/agents").send({ email: "z@example.com", name: "Z", role: "r_other" })).status).toBe(400);
    expect(H.invites).toHaveLength(0);
  });
});

describe("★ a role's set edit is audited with what it was and what it became", () => {
  it("before, after, added and removed", async () => {
    await request(app).put("/api/permissions/roles/r_sales/features").send({ features: ["conversation:messages:reply"] });
    const a = H.audits.find((x) => x.targetId === "r_sales");
    expect(a.metadata).toEqual({ change: "features", before: ["conversation:messages:read"], after: ["conversation:messages:reply"], added: ["conversation:messages:reply"], removed: ["conversation:messages:read"] });
  });
});
