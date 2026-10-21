/**
 * The Shopify authorization boundary (App Store requirement 1.2.1).
 *
 * The invariant under test: without an active Shopify Connector subscription or
 * a valid pre-publication grandfather grant, nothing Shopify-shaped is
 * available - and GOTCHA Core is untouched either way.
 *
 * These tests are written against SOURCE, not against value, because that is
 * where the previous implementation was wrong. A row saying
 * `shopify_order_read = true` is not the question; who funded it is.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({ rows: [] as any[] }));

const prismaMock = vi.hoisted(() => ({
  tenantEntitlement: {
    findMany: vi.fn(async ({ where }: any) => {
      return db.rows.filter((r: any) => {
        if (r.tenantId !== where.tenantId) return false;
        if (where.entitlementKey?.in && !where.entitlementKey.in.includes(r.entitlementKey)) return false;
        if (where.source?.in && !where.source.in.includes(r.source)) return false;
        return true;
      });
    }),
  },
}));

vi.mock("../lib/prisma", () => ({ prisma: prismaMock }));

import {
  getShopifyAuthorization,
  isShopifyAuthorized,
  assertShopifyAuthorized,
  ShopifyConnectorRequiredError,
  SHOPIFY_FUNDED_ENTITLEMENTS,
} from "../lib/billing/shopify-authorization";

const TENANT = "tenant_1";

function row(over: Partial<any> = {}) {
  return {
    tenantId: TENANT,
    entitlementKey: "shopify_catalog_sync",
    value: true,
    source: "SHOPIFY_SUBSCRIPTION",
    expiresAt: null,
    ...over,
  };
}

beforeEach(() => {
  db.rows = [];
  prismaMock.tenantEntitlement.findMany.mockClear();
});

describe("Shopify authorization: what does NOT satisfy it", () => {
  it("a workspace with nothing is denied", async () => {
    expect(await isShopifyAuthorized(TENANT)).toBe(false);
    const auth = await getShopifyAuthorization(TENANT);
    expect(auth.authorized).toBe(false);
    expect(auth.reason).toBe("no_shopify_funded_entitlement");
    expect(auth.capabilities).toEqual([]);
  });

  // The central claim of the whole change: a GOTCHA Core plan cannot buy
  // Shopify. PLAN_DEFAULT is what a Core PlanVersion writes.
  it("a Core plan granting a shopify_* key does NOT authorize Shopify", async () => {
    db.rows = SHOPIFY_FUNDED_ENTITLEMENTS.map((k) =>
      row({ entitlementKey: k, source: "PLAN_DEFAULT" }),
    );
    expect(await isShopifyAuthorized(TENANT)).toBe(false);
  });

  it.each(["OVERRIDE", "PROMO", "TRIAL", "BETA", "ADDON", "VOLUME_OPTION"])(
    "a %s grant does NOT authorize Shopify",
    async (source) => {
      db.rows = [row({ source })];
      expect(await isShopifyAuthorized(TENANT)).toBe(false);
    },
  );

  it("an EXPIRED Shopify subscription grant is denied, and says so distinctly", async () => {
    db.rows = [row({ expiresAt: new Date(Date.now() - 1000) })];
    const auth = await getShopifyAuthorization(TENANT);
    expect(auth.authorized).toBe(false);
    expect(auth.reason).toBe("entitlement_expired");
  });

  it("a Shopify row explicitly set false is denied", async () => {
    db.rows = [row({ value: false })];
    expect(await isShopifyAuthorized(TENANT)).toBe(false);
  });

  it("another workspace's subscription does not leak across tenants", async () => {
    db.rows = [row({ tenantId: "someone_else" })];
    expect(await isShopifyAuthorized(TENANT)).toBe(false);
  });

  it("an empty tenant id is denied without touching the database", async () => {
    expect(await isShopifyAuthorized("")).toBe(false);
    expect(prismaMock.tenantEntitlement.findMany).not.toHaveBeenCalled();
  });
});

describe("Shopify authorization: what DOES satisfy it", () => {
  it("an active Connector subscription authorizes exactly its declared capabilities", async () => {
    db.rows = [
      row({ entitlementKey: "shopify_catalog_sync" }),
      row({ entitlementKey: "shopify_order_read" }),
    ];
    const auth = await getShopifyAuthorization(TENANT);
    expect(auth.authorized).toBe(true);
    expect(auth.source).toBe("SHOPIFY_SUBSCRIPTION");
    expect(auth.capabilities.sort()).toEqual(["shopify_catalog_sync", "shopify_order_read"]);

    // Granted capabilities pass; ungranted ones do not, even though the
    // workspace IS authorized for Shopify in general.
    expect(await isShopifyAuthorized(TENANT, "shopify_order_read")).toBe(true);
    expect(await isShopifyAuthorized(TENANT, "shopify_order_actions")).toBe(false);
    expect(await isShopifyAuthorized(TENANT, "shopify_storefront_widget")).toBe(false);
  });

  it("a valid grandfather grant authorizes, and is reported as such", async () => {
    db.rows = [row({ source: "SHOPIFY_GRANDFATHERED" })];
    const auth = await getShopifyAuthorization(TENANT);
    expect(auth.authorized).toBe(true);
    expect(auth.source).toBe("SHOPIFY_GRANDFATHERED");
  });

  it("a paying subscription outranks a grandfather grant in what it reports", async () => {
    db.rows = [
      row({ source: "SHOPIFY_GRANDFATHERED" }),
      row({ entitlementKey: "shopify_order_read", source: "SHOPIFY_SUBSCRIPTION" }),
    ];
    expect((await getShopifyAuthorization(TENANT)).source).toBe("SHOPIFY_SUBSCRIPTION");
  });

  it("a not-yet-expired grant is still live", async () => {
    db.rows = [row({ expiresAt: new Date(Date.now() + 60_000) })];
    expect(await isShopifyAuthorized(TENANT)).toBe(true);
  });
});

describe("cancellation leaves Core alone", () => {
  it("removing the Shopify rows denies Shopify and does not consult any Core state", async () => {
    db.rows = [row()];
    expect(await isShopifyAuthorized(TENANT)).toBe(true);

    // What a confirmed cancellation does: the Shopify-funded rows go.
    db.rows = [];
    expect(await isShopifyAuthorized(TENANT)).toBe(false);

    // Every query this module makes is scoped to Shopify keys and Shopify
    // sources, so it is structurally incapable of revoking a Core capability.
    for (const call of prismaMock.tenantEntitlement.findMany.mock.calls) {
      const where = (call[0] as any).where;
      expect(where.entitlementKey.in).toEqual([...SHOPIFY_FUNDED_ENTITLEMENTS]);
      expect(where.source.in).toEqual(["SHOPIFY_SUBSCRIPTION", "SHOPIFY_GRANDFATHERED"]);
    }
  });
});

describe("assertShopifyAuthorized", () => {
  it("throws a typed, merchant-safe error when unauthorized", async () => {
    await expect(assertShopifyAuthorized(TENANT)).rejects.toBeInstanceOf(
      ShopifyConnectorRequiredError,
    );
    const err = await assertShopifyAuthorized(TENANT).catch((e) => e);
    expect(err.code).toBe("SHOPIFY_CONNECTOR_REQUIRED");
    expect(err.status).toBe(402);
  });

  it("throws when authorized generally but not for the requested capability", async () => {
    db.rows = [row({ entitlementKey: "shopify_catalog_sync" })];
    const err = await assertShopifyAuthorized(TENANT, "shopify_order_actions").catch((e) => e);
    expect(err).toBeInstanceOf(ShopifyConnectorRequiredError);
    expect(err.denialReason).toBe("capability_not_funded");
  });

  it("carries no credential, shop domain or subscription id in its message", async () => {
    const err = await assertShopifyAuthorized(TENANT).catch((e) => e);
    const text = `${err.message} ${JSON.stringify(err)}`;
    expect(text).not.toMatch(/shpat_|shpca_|myshopify\.com|access[_-]?token|Bearer /i);
  });

  it("returns the authorization when it passes", async () => {
    db.rows = [row()];
    await expect(assertShopifyAuthorized(TENANT, "shopify_catalog_sync")).resolves.toMatchObject({
      authorized: true,
    });
  });
});

describe("fails closed, never open", () => {
  it("a database error propagates rather than resolving to allowed", async () => {
    prismaMock.tenantEntitlement.findMany.mockRejectedValueOnce(new Error("db down"));
    await expect(isShopifyAuthorized(TENANT)).rejects.toThrow("db down");
  });
});
