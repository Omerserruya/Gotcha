/**
 * Two-layer permission resolver — unit tests for
 * `packages/shared/src/lib/permissions.ts`.
 *
 * Resolution rules under test (in priority order):
 *   1. SYSTEM_ADMIN bypasses everything.
 *   2. Tenant must have the feature enabled (or legacy column truthy).
 *   3. User-level override wins (grant=true forces access, granted=false revokes).
 *   4. ADMIN gets every tenant-enabled feature.
 *   5. AGENT: union of role grants + metadata default (defaultAgentAccess).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// vi.mock is hoisted; we have to use vi.hoisted() so the mock object is
// available inside the factory.
const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    tenantFeature: { findMany: vi.fn() },
    tenant: { findUnique: vi.fn() },
    userFeatureGrant: { findMany: vi.fn() },
    userRoleAssignment: { findMany: vi.fn() },
  },
}));

// Mock the prisma module that `permissions.ts` imports via `./prisma`.
// Vitest resolves the same absolute file regardless of which import string
// is used downstream, so mocking the canonical alias path is enough.
vi.mock("@chatcenter/shared/src/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("../../../../../packages/shared/src/lib/prisma", () => ({ prisma: mockPrisma }));

import {
  hasFeature,
  isFeatureEnabledForTenant,
  invalidatePermissionsCache,
  FEATURES,
} from "@chatcenter/shared";

const ADMIN_USER = { userId: "u-admin", tenantId: "t1", role: "ADMIN" } as const;
const AGENT_USER = { userId: "u-agent", tenantId: "t1", role: "AGENT" } as const;
const SYSADMIN = { userId: "u-sys", tenantId: "t-sys", role: "SYSTEM_ADMIN" } as const;

function setTenantFeatures(rows: Array<{ feature: string; enabled: boolean }>) {
  mockPrisma.tenantFeature.findMany.mockResolvedValue(rows);
}
function setTenantLegacy(cols: Record<string, boolean | null> = {}) {
  mockPrisma.tenant.findUnique.mockResolvedValue({
    botEnabled: cols.botEnabled ?? false,
    firstTakeCareEnabled: cols.firstTakeCareEnabled ?? false,
    voiceCopilotEnabled: cols.voiceCopilotEnabled ?? false,
    voiceInboxUiEnabled: cols.voiceInboxUiEnabled ?? false,
    voiceIncomingEnabled: cols.voiceIncomingEnabled ?? false,
  });
}
function setUserGrants(rows: Array<{ feature: string; granted: boolean }>) {
  mockPrisma.userFeatureGrant.findMany.mockResolvedValue(rows);
}
function setUserRoleFeatures(features: string[]) {
  mockPrisma.userRoleAssignment.findMany.mockResolvedValue([
    { role: { features: features.map((feature) => ({ feature })) } },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidatePermissionsCache();
  setTenantFeatures([]);
  setTenantLegacy();
  setUserGrants([]);
  setUserRoleFeatures([]);
});

describe("hasFeature — SYSTEM_ADMIN bypass", () => {
  it("returns true even when tenant has feature disabled", async () => {
    setTenantFeatures([{ feature: FEATURES.AUTO_BUY, enabled: false }]);
    expect(await hasFeature(SYSADMIN, FEATURES.AUTO_BUY)).toBe(true);
  });
});

describe("hasFeature — tenant layer", () => {
  it("denies any user when tenant has the feature disabled", async () => {
    setTenantFeatures([{ feature: FEATURES.AUTO_BUY, enabled: false }]);
    expect(await hasFeature(ADMIN_USER, FEATURES.AUTO_BUY)).toBe(false);
    expect(await hasFeature(AGENT_USER, FEATURES.AUTO_BUY)).toBe(false);
  });

  it("falls back to legacy Boolean column when no tenant_features row exists", async () => {
    setTenantFeatures([]);
    setTenantLegacy({ botEnabled: true });
    expect(await hasFeature(ADMIN_USER, FEATURES.BOT)).toBe(true);
  });

  it("isFeatureEnabledForTenant prefers tenant_features row over legacy column", async () => {
    setTenantFeatures([{ feature: FEATURES.BOT, enabled: false }]);
    setTenantLegacy({ botEnabled: true });
    expect(await isFeatureEnabledForTenant("t1", FEATURES.BOT)).toBe(false);
  });
});

describe("hasFeature — ADMIN role", () => {
  it("grants every tenant-enabled feature without explicit grant", async () => {
    setTenantFeatures([{ feature: FEATURES.AUTO_BUY, enabled: true }]);
    expect(await hasFeature(ADMIN_USER, FEATURES.AUTO_BUY)).toBe(true);
  });
});

describe("hasFeature — AGENT default access", () => {
  it("denies a default-none feature without role/user grant", async () => {
    setTenantFeatures([{ feature: FEATURES.AUTO_BUY, enabled: true }]);
    setUserRoleFeatures([]);
    expect(await hasFeature(AGENT_USER, FEATURES.AUTO_BUY)).toBe(false);
  });

  it("allows a default-all feature when tenant has it on", async () => {
    setTenantFeatures([{ feature: FEATURES.BOT, enabled: true }]);
    setUserRoleFeatures([]);
    expect(await hasFeature(AGENT_USER, FEATURES.BOT)).toBe(true);
  });

  it("allows a default-none feature when a role grants it", async () => {
    setTenantFeatures([{ feature: FEATURES.AUTO_BUY, enabled: true }]);
    setUserRoleFeatures([FEATURES.AUTO_BUY]);
    expect(await hasFeature(AGENT_USER, FEATURES.AUTO_BUY)).toBe(true);
  });
});

describe("hasFeature — user-level overrides", () => {
  it("explicit user grant beats a missing role grant", async () => {
    setTenantFeatures([{ feature: FEATURES.AUTO_BUY, enabled: true }]);
    setUserRoleFeatures([]);
    setUserGrants([{ feature: FEATURES.AUTO_BUY, granted: true }]);
    expect(await hasFeature(AGENT_USER, FEATURES.AUTO_BUY)).toBe(true);
  });

  it("explicit user revoke beats a role grant", async () => {
    setTenantFeatures([{ feature: FEATURES.AUTO_BUY, enabled: true }]);
    setUserRoleFeatures([FEATURES.AUTO_BUY]);
    setUserGrants([{ feature: FEATURES.AUTO_BUY, granted: false }]);
    expect(await hasFeature(AGENT_USER, FEATURES.AUTO_BUY)).toBe(false);
  });

  it("explicit user revoke beats ADMIN auto-access", async () => {
    setTenantFeatures([{ feature: FEATURES.AUTO_BUY, enabled: true }]);
    setUserGrants([{ feature: FEATURES.AUTO_BUY, granted: false }]);
    expect(await hasFeature(ADMIN_USER, FEATURES.AUTO_BUY)).toBe(false);
  });

  it("tenant disable still wins over a user grant", async () => {
    setTenantFeatures([{ feature: FEATURES.AUTO_BUY, enabled: false }]);
    setUserGrants([{ feature: FEATURES.AUTO_BUY, granted: true }]);
    expect(await hasFeature(AGENT_USER, FEATURES.AUTO_BUY)).toBe(false);
  });
});

describe("invalidatePermissionsCache", () => {
  it("re-reads tenant features after invalidation", async () => {
    setTenantFeatures([{ feature: FEATURES.AUTO_BUY, enabled: true }]);
    expect(await isFeatureEnabledForTenant("t1", FEATURES.AUTO_BUY)).toBe(true);
    setTenantFeatures([{ feature: FEATURES.AUTO_BUY, enabled: false }]);
    invalidatePermissionsCache({ tenantId: "t1" });
    expect(await isFeatureEnabledForTenant("t1", FEATURES.AUTO_BUY)).toBe(false);
  });
});
