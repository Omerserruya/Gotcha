/**
 * The two places a Shopify capability could previously be satisfied by
 * something GOTCHA sold: the entitlement resolver's merged view, and the
 * legacy feature table's metadata default.
 *
 * Both are provider-blind by design for every other capability, which is
 * correct - and was the defect for Shopify. These tests pin the asymmetry:
 * Shopify keys are decided by funding source, everything else is not.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({ tenantFeatures: [] as any[], entitlements: [] as any[] }));

const prismaMock = vi.hoisted(() => ({
  tenantEntitlement: {
    findMany: vi.fn(async ({ where }: any) =>
      db.entitlements.filter((r: any) => {
        if (r.tenantId !== where.tenantId) return false;
        if (where.entitlementKey?.in && !where.entitlementKey.in.includes(r.entitlementKey)) return false;
        if (where.source?.in && !where.source.in.includes(r.source)) return false;
        return true;
      }),
    ),
  },
  tenantFeature: { findMany: vi.fn(async () => db.tenantFeatures) },
  tenant: { findUnique: vi.fn(async () => ({ id: "t1" })) },
}));

vi.mock("../lib/prisma", () => ({ prisma: prismaMock }));

import { entitledIn } from "../lib/billing/entitlement-resolver";
import type { EntitlementSet } from "../lib/billing/entitlements";

function setOf(key: string, source: string, value: unknown = true): EntitlementSet {
  return {
    tenantId: "t1",
    planKey: "CORE",
    planVersion: 1,
    entries: new Map([[key, { key, valueType: "BOOLEAN" as any, value, source: source as any }]]),
    unsubscribed: false,
  } as EntitlementSet;
}

const emptySet: EntitlementSet = {
  tenantId: "t1",
  planKey: "CORE",
  planVersion: 1,
  entries: new Map(),
  unsubscribed: false,
} as EntitlementSet;

beforeEach(() => {
  db.tenantFeatures = [];
  db.entitlements = [];
});

describe("entitledIn: Shopify keys require Shopify funding", () => {
  it.each([
    "commerce.shopify_live_chat",
    "commerce.shopify_product_messaging",
  ])("%s is granted by SHOPIFY_SUBSCRIPTION", (key) => {
    expect(entitledIn(setOf(key, "SHOPIFY_SUBSCRIPTION"), key)).toBe(true);
  });

  /**
   * The four Shopify-FUNDED keys are absent from BOTH key namespaces - they are
   * not in the feature catalog and not license keys - so `isUnsellable` rejects
   * them before any funding rule runs, and `entitledIn` can never return true
   * for them no matter who paid.
   *
   * That is not a bug to fix here; it is the second reason these grants were
   * inert. `getShopifyAuthorization` therefore reads `tenant_entitlements`
   * directly rather than going through this API, and this test pins the fact so
   * nobody "fixes" the guard later by routing it through `isEntitled`.
   */
  it.each([
    "shopify_catalog_sync",
    "shopify_order_read",
    "shopify_order_actions",
    "shopify_storefront_widget",
  ])("%s is NOT reachable through entitledIn at all (use the guard)", (key) => {
    expect(entitledIn(setOf(key, "SHOPIFY_SUBSCRIPTION"), key)).toBe(false);
  });

  it.each([
    "shopify_catalog_sync",
    "commerce.shopify_live_chat",
  ])("%s is NOT granted by a Core plan default", (key) => {
    expect(entitledIn(setOf(key, "PLAN_DEFAULT"), key)).toBe(false);
  });

  it.each(["OVERRIDE", "PROMO", "TRIAL", "BETA", "ADDON", "VOLUME_OPTION"])(
    "a %s row does not grant a Shopify key",
    (source) => {
      expect(
        entitledIn(setOf("commerce.shopify_live_chat", source), "commerce.shopify_live_chat"),
      ).toBe(false);
    },
  );

  it("a grandfather grant grants a catalogued Shopify key", () => {
    expect(
      entitledIn(setOf("commerce.shopify_live_chat", "SHOPIFY_GRANDFATHERED"), "commerce.shopify_live_chat"),
    ).toBe(true);
  });

  it("COMPLIANCE_DENY still denies even from a Shopify-shaped row", () => {
    expect(
      entitledIn(setOf("commerce.shopify_live_chat", "COMPLIANCE_DENY"), "commerce.shopify_live_chat"),
    ).toBe(false);
  });

  // The catalog fallback is how the storefront widget reached every workspace.
  it("an ABSENT Shopify key never falls back to the catalog default", () => {
    expect(entitledIn(emptySet, "commerce.shopify_live_chat")).toBe(false);
    expect(entitledIn(emptySet, "commerce.shopify_product_messaging")).toBe(false);
  });

  // Fail-closed for keys nobody has registered yet.
  it("an unregistered future shopify_* key is denied rather than defaulted", () => {
    expect(entitledIn(emptySet, "shopify_some_future_capability")).toBe(false);
  });
});

describe("entitledIn: provider-neutral capabilities are untouched", () => {
  it("a non-Shopify key is still granted by a Core plan default", () => {
    expect(entitledIn(setOf("ai.copilot", "PLAN_DEFAULT"), "ai.copilot")).toBe(true);
  });

  it("a non-Shopify key is still granted by an OVERRIDE", () => {
    expect(entitledIn(setOf("ai.copilot", "OVERRIDE"), "ai.copilot")).toBe(true);
  });

  // `commerce.auto_buy` is the control: a real, catalogued capability in the
  // SAME commerce category as the Shopify pair, which must still be grantable
  // by a Core plan. If the Shopify rule had been written as "anything under
  // commerce.", this test would fail.
  it("a sibling commerce capability is still granted by a Core plan default", () => {
    expect(entitledIn(setOf("commerce.auto_buy", "PLAN_DEFAULT"), "commerce.auto_buy")).toBe(true);
  });

  /**
   * The catalog fallback still works for everything that is not Shopify.
   *
   * `communication.omnichannel` is catalogued with `defaultValue: true`, so an
   * absent row must still resolve to TRUE. This is the counterpart to the
   * Shopify case above, where an absent row now resolves to FALSE: it proves
   * the fallback was removed for Shopify specifically and not globally, which
   * is the difference between enforcing a billing boundary and breaking Core.
   */
  it("a Core capability with a TRUE catalog default still falls back to true", () => {
    expect(entitledIn(emptySet, "communication.omnichannel")).toBe(true);
  });
});
