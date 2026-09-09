/**
 * Two hardening properties, and the reason each exists.
 *
 * 1. AN UNKNOWN PLAN IS OUR FAULT, NOT THE MERCHANT'S.
 *
 *    Shopify says somebody is paying and the local catalog cannot say what
 *    they bought. Both obvious responses are wrong:
 *
 *      • granting the full set turns an unconfigured handle - a plan created
 *        in the Partner Dashboard and never wired up, or a typo in an env var -
 *        into a way to widen access without review;
 *      • revoking cuts off a demonstrably paying merchant because OUR config is
 *        wrong, which during a bad deploy is an outage for every paying store
 *        at once.
 *
 *    So: grant nothing, revoke nothing, say so loudly, and self-heal on the
 *    next reconciliation pass once the catalog is corrected.
 *
 * 2. APP PRICING MUST NOT BOOT HALF-CONFIGURED.
 *
 *    App Pricing sends no subscription webhooks, so the Partner API is the only
 *    way to learn that anybody paid. A service that starts without those
 *    credentials accepts installs and then cannot verify any of them.
 */
import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import { prisma } from "@chatcenter/shared";
import {
  syncProviderSubscription,
  grantShopifyEntitlements,
} from "../services/provider-subscription.service";
import { getShopifyAccessSnapshot } from "../services/shopify-billing-state.service";
import {
  assertShopifyBillingConfig,
  ShopifyBillingConfigError,
} from "../billing-sources/shopify/config";

const RUN = `unk-${Date.now().toString(36)}`;
const ORIGINAL = { ...process.env };
const tenantIds: string[] = [];
const entityIds: string[] = [];

const CONNECTOR_PLAN = {
  key: "SHOPIFY_CONNECTOR",
  productKey: "shopify_connector",
  handle: "gotcha-connector",
  visibility: "public",
  enabled: true,
  rank: 1,
  entitlements: [
    "shopify_catalog_sync",
    "shopify_order_read",
    "shopify_order_actions",
    "shopify_storefront_widget",
  ],
  restrictedToShops: [],
};

function enable(opts: { catalog?: unknown } = {}) {
  process.env.SHOPIFY_BILLING_ENABLED = "true";
  process.env.SHOPIFY_BILLING_MODE = "manual";
  process.env.SHOPIFY_BILLING_ENV = "mock";
  process.env.SHOPIFY_BILLING_POLICY_MODE = "connector_addon";
  process.env.SHOPIFY_ALLOW_SPLIT_BILLING = "true";
  process.env.SHOPIFY_APP_HANDLE = "gotcha";
  if (opts.catalog !== undefined) {
    process.env.SHOPIFY_BILLING_PLAN_CATALOG = JSON.stringify(opts.catalog);
  }
}

async function newTenant() {
  const n = `${RUN}-${Math.random().toString(36).slice(2, 8)}`;
  const tenant = await prisma.tenant.create({ data: { name: n, slug: n, status: "ACTIVE" } });
  tenantIds.push(tenant.id);
  const entity = await prisma.billableEntity.create({ data: { displayName: n } });
  entityIds.push(entity.id);
  await prisma.billableEntityTenant.create({
    data: { billableEntityId: entity.id, tenantId: tenant.id },
  });
  return { tenant, entityId: entity.id };
}

/**
 * Make the SHOPIFY source report an active subscription on a given handle.
 *
 * Mocked at the registry rather than by reaching into an adapter: the property
 * under test is what `syncProviderSubscription` DOES with an observed
 * subscription, and that must hold whichever adapter produced it.
 */
async function withObserved(
  observed: { externalId: string; planHandle: string | null; status?: string },
  fn: () => Promise<void>,
) {
  const registry = await import("../billing-sources/index");
  const spy = vi.spyOn(registry, "getBillingSource").mockReturnValue({
    source: "SHOPIFY",
    capabilities: {} as any,
    beginSubscription: async () => ({ url: null }) as any,
    fetchSubscription: async () => ({
      externalId: observed.externalId,
      status: (observed.status ?? "ACTIVE") as any,
      rawStatus: observed.status ?? "ACTIVE",
      planHandle: observed.planHandle,
      trialEndsAt: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      metadata: {},
    }),
  } as any);
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
}

async function sync(tenantId: string, billableEntityId: string) {
  return syncProviderSubscription({
    tenantId,
    billableEntityId,
    productKey: "shopify_connector",
    billingSource: "SHOPIFY",
    externalShopId: "99001122",
    environment: "mock",
  });
}

async function shopifyKeys(tenantId: string) {
  const rows = await prisma.tenantEntitlement.findMany({
    where: { tenantId, source: "SHOPIFY_SUBSCRIPTION" },
    select: { entitlementKey: true },
  });
  return rows.map((r) => r.entitlementKey).sort();
}

beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("SHOPIFY_")) delete process.env[k];
  }
});

afterEach(async () => {
  await prisma.tenantEntitlement.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.providerSubscription.deleteMany({ where: { tenantId: { in: tenantIds } } });
});

afterAll(async () => {
  process.env = { ...ORIGINAL };
  await prisma.billableEntityTenant.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.billableEntity.deleteMany({ where: { id: { in: entityIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
});

// ─── 1. Active subscription, completely missing catalog ──────────────────

describe("an active subscription with NO catalog at all", () => {
  it("grants nothing", async () => {
    enable(); // no SHOPIFY_BILLING_PLAN_CATALOG
    const { tenant, entityId } = await newTenant();

    await withObserved({ externalId: "sub-1", planHandle: "gotcha-connector" }, async () => {
      const r = await sync(tenant.id, entityId);
      expect(r.planUnknown).toBe(true);
      expect(r.entitled).toBe(false);
      expect(r.unknownPlanHandle).toBe("gotcha-connector");
    });

    expect(await shopifyKeys(tenant.id)).toEqual([]);
  });

  it("still records what Shopify said, so the subscription is not lost", async () => {
    enable();
    const { tenant, entityId } = await newTenant();
    await withObserved({ externalId: "sub-1", planHandle: "gotcha-connector" }, async () => {
      await sync(tenant.id, entityId);
    });

    const row = await prisma.providerSubscription.findFirst({ where: { tenantId: tenant.id } });
    // ACTIVE is the truth from Shopify. Downgrading it to something else would
    // lose the fact that this merchant is paying.
    expect(row?.status).toBe("ACTIVE");
    expect(row?.providerPlanHandle).toBe("gotcha-connector");
  });

  it("records an auditable, operator-facing error naming the handle", async () => {
    enable();
    const { tenant, entityId } = await newTenant();
    await withObserved({ externalId: "sub-1", planHandle: "mystery-plan" }, async () => {
      await sync(tenant.id, entityId);
    });

    const row = await prisma.providerSubscription.findFirst({ where: { tenantId: tenant.id } });
    const meta = row?.metadata as any;
    expect(meta.configurationError).toBe("unknown_plan");
    // The handle is configuration, not a credential - it is the one thing an
    // operator needs to fix this.
    expect(meta.unknownPlanHandle).toBe("mystery-plan");
    expect(meta.unknownPlanObservedAt).toBeTruthy();
    // And nothing secret rode along with it.
    expect(JSON.stringify(meta)).not.toMatch(/token|secret|shpat_/i);
  });

  it("surfaces UNKNOWN_PLAN, not ACTIVE and not ERROR", async () => {
    enable();
    const { tenant, entityId } = await newTenant();
    await withObserved({ externalId: "sub-1", planHandle: "mystery-plan" }, async () => {
      await sync(tenant.id, entityId);
    });

    const snap = await getShopifyAccessSnapshot(tenant.id);
    expect(snap.shopify.state).toBe("UNKNOWN_PLAN");
    expect(snap.shopify.reason).toBe("plan_handle_not_in_catalog");
    expect(snap.shopify.unknownPlanHandle).toBe("mystery-plan");
  });
});

// ─── 2. Active subscription, unknown handle within a real catalog ────────

describe("an active subscription on a handle the catalog does not contain", () => {
  it("grants nothing, even though other plans are configured", async () => {
    enable({ catalog: [CONNECTOR_PLAN] });
    const { tenant, entityId } = await newTenant();

    await withObserved({ externalId: "sub-2", planHandle: "gotcha-enterprise" }, async () => {
      const r = await sync(tenant.id, entityId);
      expect(r.planUnknown).toBe(true);
      expect(r.unknownPlanHandle).toBe("gotcha-enterprise");
    });

    expect(await shopifyKeys(tenant.id)).toEqual([]);
  });

  it("a subscription reporting NO handle is also unknown, not a free pass", async () => {
    enable({ catalog: [CONNECTOR_PLAN] });
    const { tenant, entityId } = await newTenant();
    await withObserved({ externalId: "sub-3", planHandle: null }, async () => {
      const r = await sync(tenant.id, entityId);
      expect(r.planUnknown).toBe(true);
    });
    expect(await shopifyKeys(tenant.id)).toEqual([]);
  });

  it("leaves the connection BILLING_PENDING rather than CONNECTED", async () => {
    enable({ catalog: [CONNECTOR_PLAN] });
    const { tenant, entityId } = await newTenant();
    const conn = await prisma.commerceConnection.create({
      data: {
        tenantId: tenant.id,
        platform: "SHOPIFY",
        externalShopId: `s-${RUN}-${Math.random().toString(36).slice(2, 8)}`,
        shopDomain: "acme.myshopify.com",
        status: "BILLING_PENDING",
      },
    });

    await withObserved({ externalId: "sub-4", planHandle: "nope" }, async () => {
      await syncProviderSubscription({
        tenantId: tenant.id,
        billableEntityId: entityId,
        productKey: "shopify_connector",
        billingSource: "SHOPIFY",
        externalShopId: conn.externalShopId,
        commerceConnectionId: conn.id,
        environment: "mock",
      });
    });

    const after = await prisma.commerceConnection.findUnique({ where: { id: conn.id } });
    expect(after?.status).toBe("BILLING_PENDING");
    await prisma.commerceConnection.delete({ where: { id: conn.id } });
  });
});

// ─── 3. Previously verified entitlements survive a missing catalog ───────

describe("a temporarily missing catalog does NOT revoke what was already verified", () => {
  it("keeps existing entitlements when the catalog disappears", async () => {
    // The scenario: a deploy ships without the env var. Every paying merchant
    // would otherwise lose access at once, because OUR config broke.
    enable({ catalog: [CONNECTOR_PLAN] });
    const { tenant, entityId } = await newTenant();

    await withObserved({ externalId: "sub-5", planHandle: "gotcha-connector" }, async () => {
      await sync(tenant.id, entityId);
    });
    expect(await shopifyKeys(tenant.id)).toHaveLength(4);

    // The catalog vanishes.
    delete process.env.SHOPIFY_BILLING_PLAN_CATALOG;

    await withObserved({ externalId: "sub-5", planHandle: "gotcha-connector" }, async () => {
      const r = await sync(tenant.id, entityId);
      expect(r.planUnknown).toBe(true);
    });

    // Still theirs. Untouched.
    expect(await shopifyKeys(tenant.id)).toHaveLength(4);
  });

  it("a genuine cancellation still revokes, catalog or not", async () => {
    // The guard must not become a way for a cancelled subscription to keep
    // access: `planUnknown` only applies when Shopify says they ARE paying.
    enable({ catalog: [CONNECTOR_PLAN] });
    const { tenant, entityId } = await newTenant();
    await grantShopifyEntitlements(tenant.id, "psub-seed", "SHOPIFY_CONNECTOR");
    expect(await shopifyKeys(tenant.id)).toHaveLength(4);

    delete process.env.SHOPIFY_BILLING_PLAN_CATALOG;
    await withObserved(
      { externalId: "sub-6", planHandle: "gotcha-connector", status: "CANCELLED" },
      async () => {
        const r = await sync(tenant.id, entityId);
        expect(r.planUnknown).toBe(false);
      },
    );

    expect(await shopifyKeys(tenant.id)).toEqual([]);
  });
});

// ─── 4. Reconciliation after the catalog is corrected ────────────────────

describe("adding the plan to the catalog repairs it on the next pass", () => {
  it("grants on the next sync, with no operator action beyond the fix", async () => {
    enable(); // broken: no catalog
    const { tenant, entityId } = await newTenant();

    await withObserved({ externalId: "sub-7", planHandle: "gotcha-connector" }, async () => {
      await sync(tenant.id, entityId);
    });
    expect(await shopifyKeys(tenant.id)).toEqual([]);
    expect((await getShopifyAccessSnapshot(tenant.id)).shopify.state).toBe("UNKNOWN_PLAN");

    // The operator adds the handle.
    process.env.SHOPIFY_BILLING_PLAN_CATALOG = JSON.stringify([CONNECTOR_PLAN]);

    await withObserved({ externalId: "sub-7", planHandle: "gotcha-connector" }, async () => {
      const r = await sync(tenant.id, entityId);
      expect(r.planUnknown).toBe(false);
      expect(r.entitled).toBe(true);
    });

    expect(await shopifyKeys(tenant.id)).toEqual([
      "shopify_catalog_sync",
      "shopify_order_actions",
      "shopify_order_read",
      "shopify_storefront_widget",
    ]);

    const snap = await getShopifyAccessSnapshot(tenant.id);
    expect(snap.shopify.state).toBe("ACTIVE");
    expect(snap.shopify.unknownPlanHandle).toBeNull();
  });
});

// ─── Startup validation ──────────────────────────────────────────────────

describe("startup validation for app_pricing", () => {
  function appPricing(env: "mock" | "test" | "live") {
    process.env.SHOPIFY_BILLING_ENABLED = "true";
    process.env.SHOPIFY_BILLING_MODE = "app_pricing";
    process.env.SHOPIFY_BILLING_ENV = env;
    if (env === "live") process.env.SHOPIFY_ALLOW_LIVE_BILLING = "true";
    process.env.SHOPIFY_APP_HANDLE = "gotcha";
  }

  function partnerCreds() {
    process.env.SHOPIFY_PARTNER_API_TOKEN = "PLACEHOLDER";
    process.env.SHOPIFY_PARTNER_ORGANIZATION_ID = "1234567";
    process.env.SHOPIFY_PARTNER_APP_ID = "98765432";
  }

  it("disabled billing boots with nothing configured at all", () => {
    expect(() => assertShopifyBillingConfig()).not.toThrow();
  });

  it("refuses app_pricing with no sellable plan, in EVERY environment", () => {
    // Including mock. Without a catalog a merchant can approve a charge this
    // deployment cannot interpret, and would be billed without getting access.
    appPricing("mock");
    expect(() => assertShopifyBillingConfig()).toThrow(ShopifyBillingConfigError);
    expect(() => assertShopifyBillingConfig()).toThrow(/SHOPIFY_BILLING_PLAN_CATALOG/);
  });

  it("refuses a catalog whose only plan has no handle", () => {
    appPricing("mock");
    process.env.SHOPIFY_BILLING_PLAN_CATALOG = JSON.stringify([{ key: "DRAFT" }]);
    expect(() => assertShopifyBillingConfig()).toThrow(/no sellable plan/);
  });

  it("refuses a catalog whose only plan is disabled", () => {
    appPricing("mock");
    process.env.SHOPIFY_BILLING_PLAN_CATALOG = JSON.stringify([
      { ...CONNECTOR_PLAN, enabled: false },
    ]);
    expect(() => assertShopifyBillingConfig()).toThrow(/no sellable plan/);
  });

  it("mock may boot WITHOUT Partner API credentials", () => {
    // Safe only because mock performs no network call and can neither create
    // nor verify a real subscription.
    appPricing("mock");
    process.env.SHOPIFY_BILLING_PLAN_CATALOG = JSON.stringify([CONNECTOR_PLAN]);
    expect(() => assertShopifyBillingConfig()).not.toThrow();
  });

  it("test REQUIRES all three Partner API values", () => {
    appPricing("test");
    process.env.SHOPIFY_BILLING_PLAN_CATALOG = JSON.stringify([CONNECTOR_PLAN]);
    expect(() => assertShopifyBillingConfig()).toThrow(/SHOPIFY_PARTNER_API_TOKEN/);
    expect(() => assertShopifyBillingConfig()).toThrow(/SHOPIFY_PARTNER_ORGANIZATION_ID/);
    expect(() => assertShopifyBillingConfig()).toThrow(/SHOPIFY_PARTNER_APP_ID/);
  });

  it("names every missing value at once, not one per restart", () => {
    appPricing("test");
    process.env.SHOPIFY_BILLING_PLAN_CATALOG = JSON.stringify([CONNECTOR_PLAN]);
    process.env.SHOPIFY_PARTNER_API_TOKEN = "PLACEHOLDER";
    try {
      assertShopifyBillingConfig();
      throw new Error("expected a throw");
    } catch (e: any) {
      expect(e.message).toMatch(/SHOPIFY_PARTNER_ORGANIZATION_ID/);
      expect(e.message).toMatch(/SHOPIFY_PARTNER_APP_ID/);
      // The token was supplied, so it must NOT be listed as missing.
      expect(e.message).not.toMatch(/SHOPIFY_PARTNER_API_TOKEN/);
    }
  });

  it("never echoes a credential VALUE into the error", () => {
    appPricing("test");
    process.env.SHOPIFY_BILLING_PLAN_CATALOG = JSON.stringify([CONNECTOR_PLAN]);
    process.env.SHOPIFY_PARTNER_API_TOKEN = "prtapi_supersecret_value";
    try {
      assertShopifyBillingConfig();
    } catch (e: any) {
      expect(e.message).not.toMatch(/supersecret/);
    }
  });

  it("live REQUIRES all three as well", () => {
    appPricing("live");
    process.env.SHOPIFY_BILLING_PLAN_CATALOG = JSON.stringify([CONNECTOR_PLAN]);
    expect(() => assertShopifyBillingConfig()).toThrow(/SHOPIFY_PARTNER/);
  });

  it("boots once everything App Pricing needs is present", () => {
    appPricing("test");
    process.env.SHOPIFY_BILLING_PLAN_CATALOG = JSON.stringify([CONNECTOR_PLAN]);
    partnerCreds();
    expect(() => assertShopifyBillingConfig()).not.toThrow();
  });

  it("manual mode needs no Partner API values and no catalog", () => {
    // The Billing API uses the shop's own Admin token, so none of this applies.
    process.env.SHOPIFY_BILLING_ENABLED = "true";
    process.env.SHOPIFY_BILLING_MODE = "manual";
    process.env.SHOPIFY_BILLING_ENV = "test";
    expect(() => assertShopifyBillingConfig()).not.toThrow();
  });
});
