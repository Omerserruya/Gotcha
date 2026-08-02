import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Proves the bridge WRITES, not just that it is declared.
 *
 * `materializeEntitlements` projects the commercial answer into
 * `tenant_features`. Capabilities whose gate reads a legacy key
 * (`shopify_live_chat`) rather than the canonical one
 * (`commerce.shopify_live_chat`) need BOTH rows written, or a plan can grant
 * or withhold the capability and the `requireFeature` guard protecting it will
 * never see the change - it keeps answering from `FEATURE_METADATA.defaultEnabled`.
 *
 * The declaration side (no typos, no collisions, defaults agree) is checked in
 * enforcement-contract.test.ts. This file checks the row actually lands.
 */

const upserts: Array<{ feature: string; enabled: boolean }> = [];

const resolved = {
  tenantId: "t1",
  planKey: "foundation",
  planVersion: 1,
  unsubscribed: false,
  entries: new Map<string, any>(),
};

vi.mock("../../prisma", () => ({
  prisma: {
    tenantFeature: {
      upsert: async ({ where, create }: any) => {
        upserts.push({ feature: where.tenantId_feature.feature, enabled: create.enabled });
      },
    },
  },
}));

vi.mock("../../permissions", () => ({ invalidatePermissionsCache: () => {} }));

vi.mock("../entitlement-resolver", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, resolveEntitlements: async () => resolved };
});

import { materializeEntitlements } from "../entitlements";
import { FEATURE_CATALOG } from "../feature-catalog";

const BRIDGED = FEATURE_CATALOG.find((f) => f.materializesTo)!;

beforeEach(() => {
  upserts.length = 0;
  resolved.entries = new Map();
});

const put = (key: string, value: unknown, valueType = "BOOLEAN") =>
  resolved.entries.set(key, { key, valueType, value, source: "PLAN_DEFAULT" });

describe("materializing a bridged capability", () => {
  it("writes the canonical row AND the legacy row the gate reads", async () => {
    put(BRIDGED.key, { bool: true });
    await materializeEntitlements("t1");

    const written = upserts.map((u) => u.feature);
    expect(written).toContain(BRIDGED.key);
    expect(written, `the ${BRIDGED.materializesTo} row is what requireFeature reads`)
      .toContain(BRIDGED.materializesTo);
  });

  it("carries the SAME answer to both rows", async () => {
    // If they could disagree, the gate and the console would each be able to
    // claim a different truth about the same capability.
    put(BRIDGED.key, { bool: false });
    await materializeEntitlements("t1");

    const canonical = upserts.find((u) => u.feature === BRIDGED.key);
    const legacy = upserts.find((u) => u.feature === BRIDGED.materializesTo);
    expect(canonical?.enabled).toBe(false);
    expect(legacy?.enabled).toBe(false);
  });

  it("withholding the capability turns the legacy row OFF", async () => {
    // The reason the bridge exists. A plan that does not sell this must
    // actually close the gate, not just record a false somewhere unread.
    put(BRIDGED.key, { bool: false });
    await materializeEntitlements("t1");
    expect(upserts.find((u) => u.feature === BRIDGED.materializesTo)?.enabled).toBe(false);
  });

  it("a COMPLIANCE_DENY reaches the legacy row too", async () => {
    // The deny is applied by `entitledIn`, which materialization routes
    // through. A deny that stopped at the canonical row would leave the
    // product still serving the capability.
    resolved.entries.set(BRIDGED.key, {
      key: BRIDGED.key, valueType: "BOOLEAN", value: { bool: true }, source: "COMPLIANCE_DENY",
    });
    await materializeEntitlements("t1");
    expect(upserts.find((u) => u.feature === BRIDGED.materializesTo)?.enabled).toBe(false);
    expect(upserts.find((u) => u.feature === BRIDGED.key)?.enabled).toBe(false);
  });
});

describe("materializing an unbridged capability", () => {
  it("writes only its own row", async () => {
    const plain = FEATURE_CATALOG.find(
      (f) => !f.materializesTo && f.entitlementType === "BOOLEAN",
    )!;
    put(plain.key, { bool: true });
    await materializeEntitlements("t1");
    expect(upserts.map((u) => u.feature)).toEqual([plain.key]);
  });

  it("skips non-BOOLEAN entitlements entirely", async () => {
    // Limits are read by `resolveLimit`, not by the feature gate. Writing a
    // count into a boolean row would read as "enabled" for any limit above 0
    // - and, worse, as enabled for a limit of 0.
    put("limit:users", { count: 0 }, "COUNTER");
    await materializeEntitlements("t1");
    expect(upserts).toEqual([]);
  });
});
