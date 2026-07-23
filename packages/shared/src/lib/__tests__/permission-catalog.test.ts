import { describe, it, expect } from "vitest";
import {
  PERMISSIONS,
  ALL_PERMISSION_KEYS,
  ALL_LICENSE_KEYS,
  BUILTIN_ROLES,
  expandPermissionPattern,
  expandPermissionPatterns,
  licenseKeysFor,
  featureLicenseKey,
  subFeatureLicenseKey,
  builtinRoleForLegacy,
  maxScope,
  isPermissionKey,
  getPermission,
} from "../permission-catalog";

describe("permission-catalog: key integrity", () => {
  it("every key is feature:sub-feature:action (3 lower-kebab segments)", () => {
    for (const d of PERMISSIONS) {
      expect(d.key.split(":")).toHaveLength(3);
      expect(d.key).toMatch(/^[a-z0-9-]+:[a-z0-9-]+:[a-z0-9-]+$/);
      expect(`${d.feature}:${d.subFeature}:${d.action}`).toBe(d.key);
    }
  });

  it("keys are unique", () => {
    expect(new Set(ALL_PERMISSION_KEYS).size).toBe(ALL_PERMISSION_KEYS.length);
  });

  it("no permission key contains scope words (scope is independent)", () => {
    for (const k of ALL_PERMISSION_KEYS) {
      expect(k.endsWith(":own")).toBe(false);
      expect(k.endsWith(":team")).toBe(false);
      expect(k.endsWith(":all")).toBe(false);
    }
  });
});

describe("permission-catalog: wildcard expansion", () => {
  it('"*" expands to every permission', () => {
    expect(expandPermissionPattern("*").sort()).toEqual([...ALL_PERMISSION_KEYS].sort());
  });

  it('domain wildcard "ai:*" expands to only ai keys', () => {
    const ai = expandPermissionPattern("ai:*");
    expect(ai.length).toBeGreaterThan(0);
    expect(ai.every((k) => k.startsWith("ai:"))).toBe(true);
  });

  it('sub-feature wildcard "conversation:messages:*" matches the action set', () => {
    const msgs = expandPermissionPattern("conversation:messages:*");
    expect(msgs).toContain("conversation:messages:reply");
    expect(msgs).toContain("conversation:messages:close");
    expect(msgs.every((k) => k.startsWith("conversation:messages:"))).toBe(true);
  });

  it("exact key passes through; unknown key drops", () => {
    expect(expandPermissionPattern("crm:deals:read")).toEqual(["crm:deals:read"]);
    expect(expandPermissionPattern("nope:nope:nope")).toEqual([]);
  });

  it("expandPermissionPatterns de-duplicates across patterns", () => {
    const set = expandPermissionPatterns(["ai:*", "ai:knowledge:read"]);
    expect(set.has("ai:knowledge:read")).toBe(true);
    // No duplicates by virtue of being a Set
    expect([...set].length).toBe(new Set(set).size);
  });
});

describe("permission-catalog: licensing", () => {
  it("derives feature + sub-feature license keys", () => {
    expect(featureLicenseKey("analytics:dashboard:read")).toBe("analytics");
    expect(subFeatureLicenseKey("analytics:dashboard:read")).toBe("analytics:dashboard");
    expect(licenseKeysFor("analytics:dashboard:read")).toEqual([
      "analytics:dashboard",
      "analytics",
    ]);
  });

  it("ALL_LICENSE_KEYS contains both feature and sub-feature nodes", () => {
    expect(ALL_LICENSE_KEYS).toContain("analytics");
    expect(ALL_LICENSE_KEYS).toContain("analytics:dashboard");
    expect(ALL_LICENSE_KEYS).toContain("conversation:messages");
  });
});

describe("permission-catalog: built-in roles", () => {
  it("owner holds the full wildcard and workspace scope", () => {
    expect(BUILTIN_ROLES.owner.permissions).toEqual(["*"]);
    expect(BUILTIN_ROLES.owner.defaultScope).toBe("workspace");
    expect(expandPermissionPatterns(BUILTIN_ROLES.owner.permissions).size).toBe(
      ALL_PERMISSION_KEYS.length,
    );
  });

  it("admin holds everything EXCEPT owner-only keys", () => {
    const admin = expandPermissionPatterns(BUILTIN_ROLES.admin.permissions);
    expect(admin.has("settings:members:manage")).toBe(true);
    expect(admin.has("settings:billing:manage")).toBe(false);
    expect(admin.has("settings:billing:cancel")).toBe(false);
    expect(admin.has("settings:roles:manage")).toBe(false);
    expect(admin.has("settings:api-keys:manage")).toBe(false);
  });

  it("cancellation is a distinct owner-only permission (not merely billing:manage)", () => {
    // The permission exists in the catalog...
    expect(isPermissionKey("settings:billing:cancel")).toBe(true);
    // ...and is a 3-part settings/configuration key like its siblings.
    expect(getPermission("settings:billing:cancel")?.domain).toBe("settings");
    // Owners hold it (via the "*" wildcard); admins do NOT (owner-only).
    const owner = expandPermissionPatterns(BUILTIN_ROLES.owner.permissions);
    const admin = expandPermissionPatterns(BUILTIN_ROLES.admin.permissions);
    expect(owner.has("settings:billing:cancel")).toBe(true);
    expect(admin.has("settings:billing:cancel")).toBe(false);
    // It is a SEPARATE key from manage, so a tenant can delegate one without the other.
    expect("settings:billing:cancel").not.toBe("settings:billing:manage");
  });

  it("agent is a strict subset of department_manager", () => {
    const agent = expandPermissionPatterns(BUILTIN_ROLES.agent.permissions);
    const mgr = expandPermissionPatterns(BUILTIN_ROLES.department_manager.permissions);
    for (const k of agent) expect(mgr.has(k)).toBe(true);
    expect(mgr.size).toBeGreaterThan(agent.size);
  });

  it("scope ordering: agent < manager < admin/owner", () => {
    expect(BUILTIN_ROLES.agent.defaultScope).toBe("own");
    expect(BUILTIN_ROLES.department_manager.defaultScope).toBe("department");
    expect(BUILTIN_ROLES.admin.defaultScope).toBe("workspace");
  });

  it("all built-in role permission patterns are valid", () => {
    for (const role of Object.values(BUILTIN_ROLES)) {
      const expanded = expandPermissionPatterns(role.permissions);
      for (const k of expanded) expect(isPermissionKey(k)).toBe(true);
    }
  });
});

describe("permission-catalog: legacy bridge + scope math", () => {
  it("maps legacy enum + departmentRole to a built-in role", () => {
    expect(builtinRoleForLegacy("ADMIN")).toBe("admin");
    expect(builtinRoleForLegacy("AGENT")).toBe("agent");
    expect(builtinRoleForLegacy("AGENT", "MANAGER")).toBe("department_manager");
    expect(builtinRoleForLegacy("SYSTEM_ADMIN")).toBeNull();
  });

  it("maxScope returns the higher-reach scope", () => {
    expect(maxScope("own", "department")).toBe("department");
    expect(maxScope("workspace", "team")).toBe("workspace");
    expect(maxScope("own", "own")).toBe("own");
  });
});
