import { describe, it, expect, beforeEach, vi } from "vitest";

// Controllable in-memory data for the mocked prisma client.
const db = {
  tenantFeature: [] as Array<{ tenantId: string; feature: string; enabled: boolean }>,
  userFeatureGrant: [] as Array<{ userId: string; feature: string; granted: boolean }>,
  userRoleAssignment: [] as Array<{
    userId: string;
    scope: string | null;
    role: { defaultScope: string; features: { feature: string }[] };
  }>,
};

vi.mock("../prisma", () => ({
  prisma: {
    tenantFeature: {
      findMany: async ({ where }: any) =>
        db.tenantFeature.filter((r) => r.tenantId === where.tenantId),
    },
    tenant: { findUnique: async () => null },
    userFeatureGrant: {
      findMany: async ({ where }: any) =>
        db.userFeatureGrant.filter((r) => r.userId === where.userId),
    },
    userRoleAssignment: {
      findMany: async ({ where }: any) =>
        db.userRoleAssignment.filter((r) => r.userId === where.userId),
    },
  },
}));

import {
  hasPermission,
  getUserPermissions,
  resolveUserScope,
  isPermissionLicensed,
  invalidatePermissionsCache,
  type PermissionPrincipal,
} from "../permissions";
import { ALL_PERMISSION_KEYS } from "../permission-catalog";

function reset() {
  db.tenantFeature = [];
  db.userFeatureGrant = [];
  db.userRoleAssignment = [];
  invalidatePermissionsCache();
}

beforeEach(reset);

describe("hasPermission: SYSTEM_ADMIN platform bypass", () => {
  it("allows any known permission and denies unknown keys", async () => {
    const sa: PermissionPrincipal = { userId: "sa", tenantId: "t1", role: "SYSTEM_ADMIN" };
    expect(await hasPermission(sa, "settings:billing:manage")).toBe(true);
    expect(await hasPermission(sa, "bogus:key:here")).toBe(false);
  });
});

describe("hasPermission: role layer via explicit assignment", () => {
  it("grants a permission present in an assigned role", async () => {
    db.userRoleAssignment.push({
      userId: "u1",
      scope: null,
      role: { defaultScope: "OWN", features: [{ feature: "conversation:messages:reply" }] },
    });
    const u: PermissionPrincipal = { userId: "u1", tenantId: "t1", role: "AGENT" };
    expect(await hasPermission(u, "conversation:messages:reply")).toBe(true);
    expect(await hasPermission(u, "settings:members:manage")).toBe(false);
  });

  it("expands wildcard role permissions", async () => {
    db.userRoleAssignment.push({
      userId: "u2",
      scope: null,
      role: { defaultScope: "WORKSPACE", features: [{ feature: "*" }] },
    });
    const u: PermissionPrincipal = { userId: "u2", tenantId: "t1", role: "AGENT" };
    expect(await hasPermission(u, "settings:roles:manage")).toBe(true);
  });
});

describe("hasPermission: user grant/revoke override wins over role", () => {
  it("explicit revoke overrides a role grant", async () => {
    db.userRoleAssignment.push({
      userId: "u3",
      scope: null,
      role: { defaultScope: "OWN", features: [{ feature: "conversation:messages:reply" }] },
    });
    db.userFeatureGrant.push({ userId: "u3", feature: "conversation:messages:reply", granted: false });
    const u: PermissionPrincipal = { userId: "u3", tenantId: "t1", role: "AGENT" };
    expect(await hasPermission(u, "conversation:messages:reply")).toBe(false);
  });

  it("explicit grant overrides a missing role grant", async () => {
    db.userRoleAssignment.push({
      userId: "u4",
      scope: null,
      role: { defaultScope: "OWN", features: [{ feature: "conversation:messages:read" }] },
    });
    db.userFeatureGrant.push({ userId: "u4", feature: "crm:deals:update", granted: true });
    const u: PermissionPrincipal = { userId: "u4", tenantId: "t1", role: "AGENT" };
    expect(await hasPermission(u, "crm:deals:update")).toBe(true);
  });
});

describe("license layer: default-allow, explicit-disable blocks", () => {
  it("permission allowed when no license rows exist (packaging off)", async () => {
    expect(await isPermissionLicensed("t1", "analytics:dashboard:read")).toBe(true);
  });

  it("explicit feature-level disable blocks even a granted permission", async () => {
    db.tenantFeature.push({ tenantId: "t1", feature: "analytics", enabled: false });
    db.userRoleAssignment.push({
      userId: "u5",
      scope: null,
      role: { defaultScope: "WORKSPACE", features: [{ feature: "*" }] },
    });
    const u: PermissionPrincipal = { userId: "u5", tenantId: "t1", role: "AGENT" };
    expect(await isPermissionLicensed("t1", "analytics:dashboard:read")).toBe(false);
    expect(await hasPermission(u, "analytics:dashboard:read")).toBe(false);
    // unaffected domain still allowed
    expect(await hasPermission(u, "crm:deals:read")).toBe(true);
  });

  it("sub-feature disable wins over feature enable (most specific)", async () => {
    db.tenantFeature.push({ tenantId: "t1", feature: "analytics", enabled: true });
    db.tenantFeature.push({ tenantId: "t1", feature: "analytics:reports", enabled: false });
    expect(await isPermissionLicensed("t1", "analytics:dashboard:read")).toBe(true);
    expect(await isPermissionLicensed("t1", "analytics:reports:export")).toBe(false);
  });
});

describe("migration bridge: no assignment → derive from legacy enum (parity)", () => {
  it("legacy ADMIN gets all-but-owner-only", async () => {
    const u: PermissionPrincipal = { userId: "legacyAdmin", tenantId: "t1", role: "ADMIN" };
    expect(await hasPermission(u, "settings:members:manage")).toBe(true);
    expect(await hasPermission(u, "settings:billing:manage")).toBe(false);
  });

  it("legacy AGENT gets agent set only", async () => {
    const u: PermissionPrincipal = { userId: "legacyAgent", tenantId: "t1", role: "AGENT" };
    expect(await hasPermission(u, "conversation:messages:reply")).toBe(true);
    expect(await hasPermission(u, "ai:employees:update")).toBe(false);
  });

  it("legacy AGENT+MANAGER gets department-manager set", async () => {
    const u: PermissionPrincipal = {
      userId: "legacyMgr",
      tenantId: "t1",
      role: "AGENT",
      departmentRole: "MANAGER",
    };
    expect(await hasPermission(u, "conversation:messages:assign")).toBe(true);
    expect(await hasPermission(u, "approvals:requests:approve")).toBe(true);
  });
});

describe("scope resolution", () => {
  it("inherits role defaultScope when assignment scope is null", async () => {
    db.userRoleAssignment.push({
      userId: "s1",
      scope: null,
      role: { defaultScope: "DEPARTMENT", features: [] },
    });
    const u: PermissionPrincipal = { userId: "s1", tenantId: "t1", role: "AGENT" };
    expect(await resolveUserScope(u)).toBe("department");
  });

  it("assignment scope override wins; max across roles", async () => {
    db.userRoleAssignment.push(
      { userId: "s2", scope: "OWN", role: { defaultScope: "OWN", features: [] } },
      { userId: "s2", scope: "WORKSPACE", role: { defaultScope: "TEAM", features: [] } },
    );
    const u: PermissionPrincipal = { userId: "s2", tenantId: "t1", role: "AGENT" };
    expect(await resolveUserScope(u)).toBe("workspace");
  });

  it("SYSTEM_ADMIN resolves to workspace", async () => {
    const sa: PermissionPrincipal = { userId: "sa", tenantId: "t1", role: "SYSTEM_ADMIN" };
    expect(await resolveUserScope(sa)).toBe("workspace");
  });
});

describe("getUserPermissions", () => {
  it("SYSTEM_ADMIN returns the full catalog", async () => {
    const sa: PermissionPrincipal = { userId: "sa", tenantId: "t1", role: "SYSTEM_ADMIN" };
    expect((await getUserPermissions(sa)).sort()).toEqual([...ALL_PERMISSION_KEYS].sort());
  });

  it("applies grants on top of role set and filters by license", async () => {
    db.userRoleAssignment.push({
      userId: "g1",
      scope: null,
      role: { defaultScope: "OWN", features: [{ feature: "conversation:messages:read" }] },
    });
    db.userFeatureGrant.push({ userId: "g1", feature: "crm:deals:read", granted: true });
    db.tenantFeature.push({ tenantId: "t1", feature: "crm", enabled: false });
    const u: PermissionPrincipal = { userId: "g1", tenantId: "t1", role: "AGENT" };
    const perms = await getUserPermissions(u);
    expect(perms).toContain("conversation:messages:read");
    // crm:deals:read granted but crm de-licensed → filtered out
    expect(perms).not.toContain("crm:deals:read");
  });
});
