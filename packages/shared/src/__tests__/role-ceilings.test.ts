/**
 * Editable roles with ceilings, Owner+Admin as one role (Omer, 2026-10-11),
 * through the real hasPermission / getUserPermissions / seedTenantRoles /
 * mergeAdminIntoOwner. The database is an in-memory double.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  assignments: {} as Record<string, Array<{ scope: string | null; role: { defaultScope: string; builtinKey: string | null; features: Array<{ feature: string }> } }>>,
  grants: {} as Record<string, Array<{ feature: string; granted: boolean; expiresAt: Date | null }>>,
  roles: [] as any[],
  settings: [] as any[],
  ura: [] as Array<{ userId: string; roleId: string; assignedBy?: string }>,
  featureWrites: [] as string[],
}));

vi.mock("../lib/prisma", () => {
  const prisma: any = {
    tenantFeature: { findMany: async () => [] },
    tenant: { findUnique: async () => null },
    userFeatureGrant: { findMany: async (a: any) => H.grants[a.where.userId] ?? [] },
    userRoleAssignment: {
      findMany: async (a: any) => (a.where.roleId ? H.ura.filter((x) => x.roleId === a.where.roleId) : H.assignments[a.where.userId] ?? []),
      findFirst: async (a: any) => H.ura.find((x) => x.userId === a.where.userId && x.roleId === a.where.roleId) ?? null,
      create: async (a: any) => { H.ura.push({ ...a.data }); return a.data; },
      deleteMany: async (a: any) => { H.ura = H.ura.filter((x) => !(x.userId === a.where.userId && x.roleId === a.where.roleId)); return { count: 1 }; },
      upsert: async (a: any) => { if (!H.ura.some((x) => x.userId === a.create.userId && x.roleId === a.create.roleId)) H.ura.push({ ...a.create }); return a.create; },
    },
    tenantRole: {
      findFirst: async (a: any) => H.roles.find((r) => r.tenantId === a.where.tenantId && (a.where.OR ? a.where.OR.some((o: any) => (o.builtinKey && r.builtinKey === o.builtinKey) || (o.name && r.name === o.name)) : r.builtinKey === a.where.builtinKey)) ?? null,
      findMany: async (a: any) => H.roles.filter((r) => r.tenantId === a.where.tenantId && a.where.builtinKey.in.includes(r.builtinKey)),
      update: async (a: any) => { const r = H.roles.find((x) => x.id === a.where.id); Object.assign(r, a.data); return r; },
      create: async (a: any) => { const r = { id: `r_${a.data.builtinKey}`, ...a.data }; H.roles.push(r); return r; },
    },
    tenantRoleFeature: {
      deleteMany: (a: any) => ({ op: "del", roleId: a.where.roleId }),
      createMany: (a: any) => ({ op: "add", data: a.data }),
    },
    tenantSetting: {
      findFirst: async (a: any) => H.settings.find((s) => s.tenantId === a.where.tenantId && s.key === a.where.key) ?? null,
      upsert: async (a: any) => {
        const s = H.settings.find((x) => x.tenantId === a.where.tenantId_key.tenantId && x.key === a.where.tenantId_key.key);
        if (s) { Object.assign(s, a.update); return s; }
        H.settings.push({ ...a.create }); return a.create;
      },
      deleteMany: async (a: any) => { H.settings = H.settings.filter((s) => !(s.tenantId === a.where.tenantId && s.key === a.where.key)); return { count: 1 }; },
    },
  };
  prisma.$transaction = async (arg: any) => {
    if (typeof arg === "function") return arg(prisma);
    for (const o of arg) if (o?.op === "del" || o?.op === "add") H.featureWrites.push(o.op === "del" ? `del:${o.roleId}` : `add:${o.data[0]?.roleId}`);
  };
  return { prisma };
});

import { hasPermission, getUserPermissions, invalidatePermissionsCache } from "../lib/permissions";
import { ROLE_CEILINGS, OWNER_FLOOR, BUILTIN_ROLES, BUILTIN_ROLE_ORDER, builtinRoleForLegacy, expandPermissionPattern, expandPermissionPatterns, ceilingKeysFor } from "../lib/permission-catalog";
import { seedTenantRoles, customizedRoleKey } from "../lib/rbac-seed";
import { mergeAdminIntoOwner, undoMergeAdminIntoOwner, MERGE_RECORD_KEY } from "../lib/rbac-merge";

const role = (builtinKey: string | null, features: string[]) => ({ scope: null, role: { defaultScope: "OWN", builtinKey, features: features.map((feature) => ({ feature })) } });
const who = (userId: string, legacy = "AGENT") => ({ userId, tenantId: "T", role: legacy });

beforeEach(() => {
  invalidatePermissionsCache();
  H.assignments = {}; H.grants = {}; H.roles = []; H.settings = []; H.ura = []; H.featureWrites = [];
});

describe("★ the ceiling holds whatever the role, grant or custom role says", () => {
  it("an Agent role edited to \"*\" still cannot touch billing, roles or members", async () => {
    H.assignments.a = [role("agent", ["*"])];
    expect(await hasPermission(who("a"), "settings:billing:manage")).toBe(false);
    expect(await hasPermission(who("a"), "settings:roles:manage")).toBe(false);
    expect(await hasPermission(who("a"), "settings:members:manage")).toBe(false);
    expect(await hasPermission(who("a"), "conversation:messages:read")).toBe(true);
  });

  it("a grant cannot lift it; a grant below it works (decision a: dashboard allowed, off by default)", async () => {
    H.assignments.a = [role("agent", BUILTIN_ROLES.agent.permissions)];
    H.grants.a = [{ feature: "analytics:workspace:read", granted: true, expiresAt: null }];
    expect(await hasPermission(who("a"), "analytics:workspace:read")).toBe(false);
    expect(await hasPermission(who("a"), "analytics:dashboard:read")).toBe(false);
    invalidatePermissionsCache();
    H.grants.a = [{ feature: "analytics:dashboard:read", granted: true, expiresAt: null }];
    expect(await hasPermission(who("a"), "analytics:dashboard:read")).toBe(true);
  });

  it("decision b: refunds are not under the Agent ceiling (they go through approval)", async () => {
    H.assignments.a = [role("agent", [...BUILTIN_ROLES.agent.permissions, "customer:commerce:refund"])];
    expect(await hasPermission(who("a"), "customer:commerce:refund")).toBe(true);
  });

  it("someone with ONLY a custom role is capped like an Agent", async () => {
    H.assignments.c = [role(null, ["*"])];
    expect(await hasPermission(who("c"), "settings:billing:manage")).toBe(false);
    expect(await hasPermission(who("c"), "ai:employees:create")).toBe(false);
    expect(await hasPermission(who("c"), "ai:employees:read")).toBe(true);
  });

  it("a Department manager cannot invite (decision c) but keeps commerce", async () => {
    H.assignments.d = [role("department_manager", BUILTIN_ROLES.department_manager.permissions)];
    H.grants.d = [{ feature: "settings:members:manage", granted: true, expiresAt: null }];
    expect(await hasPermission(who("d"), "settings:members:manage")).toBe(false);
    expect(await hasPermission(who("d"), "customer:commerce:refund")).toBe(true);
  });

  it("the Owner holds everything, and the higher built-in decides for a person holding two", async () => {
    H.assignments.o = [role("owner", ["*"])];
    expect(await hasPermission(who("o"), "settings:billing:manage")).toBe(true);
    H.assignments.m = [role("agent", BUILTIN_ROLES.agent.permissions), role("owner", ["*"])];
    expect(await hasPermission(who("m"), "settings:billing:manage")).toBe(true);
  });

  it("getUserPermissions (the /me list) never lists a ceiling key", async () => {
    H.assignments.a = [role("agent", ["*"])];
    const list = await getUserPermissions(who("a"));
    for (const k of ceilingKeysFor("agent")) expect(list).not.toContain(k);
    expect(list).toContain("conversation:messages:read");
  });
});

describe("★ Owner and Admin are one role", () => {
  it("a legacy ADMIN with no assignment is an Owner, billing included", async () => {
    expect(builtinRoleForLegacy("ADMIN")).toBe("owner");
    expect(await hasPermission(who("legacy", "ADMIN"), "settings:billing:manage")).toBe(true);
  });

  it("admin is never seeded again", () => {
    expect(BUILTIN_ROLE_ORDER).toEqual(["owner", "department_manager", "agent"]);
  });

  it("the merge moves every Admin to Owner, recorded, and the undo puts back exactly that", async () => {
    H.roles = [{ id: "r_admin", tenantId: "T", builtinKey: "admin" }, { id: "r_owner", tenantId: "T", builtinKey: "owner" }];
    H.ura = [{ userId: "u1", roleId: "r_admin" }, { userId: "u2", roleId: "r_admin" }, { userId: "u2", roleId: "r_owner" }, { userId: "u3", roleId: "r_owner" }];
    expect(await mergeAdminIntoOwner("T")).toEqual({ moved: 2 });
    expect(H.ura.filter((x) => x.roleId === "r_admin")).toEqual([]);
    expect(H.ura.filter((x) => x.roleId === "r_owner").map((x) => x.userId).sort()).toEqual(["u1", "u2", "u3"]);
    expect(H.settings.find((s) => s.key === MERGE_RECORD_KEY)?.value.moved).toHaveLength(2);

    expect(await undoMergeAdminIntoOwner("T")).toEqual({ restored: 2 });
    const after = H.ura.map((x) => `${x.userId}:${x.roleId}`).sort();
    // u2 already was an Owner before: kept. u1 was not: removed again. u3 untouched.
    expect(after).toEqual(["u1:r_admin", "u2:r_admin", "u2:r_owner", "u3:r_owner"]);
    expect(H.settings.find((s) => s.key === MERGE_RECORD_KEY)).toBeUndefined();
  });
});

describe("★ the seed does not wipe an edited built-in across a restart", () => {
  it("an uncustomized built-in follows the catalog; a customized one is left alone; the kill switch restores the old rule", async () => {
    await seedTenantRoles("T"); // first boot creates owner, department_manager, agent
    expect(H.roles.map((r) => r.builtinKey).sort()).toEqual(["agent", "department_manager", "owner"]);
    H.featureWrites = [];
    H.settings.push({ tenantId: "T", key: customizedRoleKey("r_agent"), value: {} });
    await seedTenantRoles("T"); // restart
    expect(H.featureWrites).toContain("del:r_owner");
    expect(H.featureWrites).not.toContain("del:r_agent");

    H.featureWrites = [];
    process.env.ROLES_EDITABLE = "false";
    try { await seedTenantRoles("T"); } finally { delete process.env.ROLES_EDITABLE; }
    expect(H.featureWrites).toContain("del:r_agent");
  });
});

describe("the ceilings themselves", () => {
  it("every pattern names real keys, and no built-in's defaults break its own ceiling", () => {
    for (const [key, list] of Object.entries(ROLE_CEILINGS)) {
      for (const p of list) expect(expandPermissionPattern(p).length, `${key}: ${p}`).toBeGreaterThan(0);
      const defaults = expandPermissionPatterns(BUILTIN_ROLES[key as keyof typeof BUILTIN_ROLES].permissions);
      for (const k of ceilingKeysFor(key as any)) expect(defaults.has(k), `${key} default holds ceiling key ${k}`).toBe(false);
    }
    for (const k of OWNER_FLOOR) expect(expandPermissionPattern(k)).toEqual([k]);
  });
});
