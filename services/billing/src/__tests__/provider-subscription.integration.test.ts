/**
 * Commerce connections, verified activation, uninstall and reconciliation.
 *
 * These are the scenarios where being wrong is expensive rather than untidy: a
 * store attached to the wrong workspace, a merchant's WhatsApp cut off because
 * a Shopify charge failed, or paid access granted because a browser came back
 * from a redirect.
 */
import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import { prisma } from "@chatcenter/shared";
import {
  linkCommerceConnection,
  syncProviderSubscription,
  handleCommerceUninstall,
  reconcileProviderSubscriptions,
  revokeShopifyEntitlements,
  CrossTenantShopClaimError,
  SHOPIFY_FUNDED_ENTITLEMENTS,
} from "../services/provider-subscription.service";
import * as registry from "../billing-sources";
import type { BillingSourceProvider, ObservedSubscription } from "../billing-sources";

const RUN = `ps-${Date.now().toString(36)}`;
const ORIGINAL = { ...process.env };
const tenantIds: string[] = [];
const entityIds: string[] = [];

/** A Shopify source that reports whatever the test says Shopify reports. */
function sourceReporting(observed: ObservedSubscription | null, opts: { throws?: boolean } = {}): BillingSourceProvider {
  return {
    source: "SHOPIFY",
    capabilities: registry.SHOPIFY_APP_PRICING_CAPABILITIES,
    async beginSubscription() { throw new Error("not used"); },
    async fetchSubscription() {
      if (opts.throws) throw new Error("shopify is unreachable");
      return observed;
    },
  };
}

function shopifySays(status: string, extra: Partial<ObservedSubscription> = {}): ObservedSubscription {
  return {
    externalId: `gid://shopify/AppSubscription/${status}`,
    status: status as any,
    rawStatus: status,
    planHandle: "connector-monthly",
    currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    cancelAtPeriodEnd: false,
    metadata: {},
    ...extra,
  };
}

function use(src: BillingSourceProvider) {
  vi.spyOn(registry, "getBillingSource").mockReturnValue(src);
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

beforeEach(() => {
  vi.restoreAllMocks();
  for (const k of Object.keys(process.env)) if (k.startsWith("SHOPIFY_")) delete process.env[k];

  // The fake reports `planHandle: "connector-monthly"`, and since the
  // unknown-plan hardening a handle the catalog cannot identify grants
  // NOTHING - Shopify saying somebody pays is not enough on its own, we also
  // have to know what they bought.
  //
  // These suites are about the entitlement LIFECYCLE (active grants, cancelled
  // revokes, an outage revokes nothing), so they declare the minimal catalog
  // that makes that handle resolvable. The unknown-handle behaviour has its own
  // file: shopify-unknown-plan-and-boot.integration.test.ts.
  process.env.SHOPIFY_BILLING_PLAN_HANDLES = JSON.stringify({
    shopify_connector: "connector-monthly",
  });
});

afterEach(async () => {
  await prisma.tenantEntitlement.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.providerSubscription.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.commerceConnection.deleteMany({ where: { tenantId: { in: tenantIds } } });
});

afterAll(async () => {
  process.env = { ...ORIGINAL };
  await prisma.billableEntityTenant.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.billableEntity.deleteMany({ where: { id: { in: entityIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
});

describe("scenario 21: a shop cannot be captured by another workspace", () => {
  it("refuses to move a store that another tenant already holds", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const shop = `${RUN}-shop-1`;

    await linkCommerceConnection({
      tenantId: a.tenant.id, platform: "SHOPIFY", externalShopId: shop,
    });
    await expect(linkCommerceConnection({
      tenantId: b.tenant.id, platform: "SHOPIFY", externalShopId: shop,
    })).rejects.toBeInstanceOf(CrossTenantShopClaimError);

    // Still attached to the original workspace, untouched.
    const conn = await prisma.commerceConnection.findUnique({
      where: { platform_externalShopId: { platform: "SHOPIFY", externalShopId: shop } },
    });
    expect(conn!.tenantId).toBe(a.tenant.id);
  });

  it("scenario 13: a reinstall reuses the row rather than duplicating it", async () => {
    const a = await newTenant();
    const shop = `${RUN}-shop-2`;
    const first = await linkCommerceConnection({
      tenantId: a.tenant.id, platform: "SHOPIFY", externalShopId: shop, acquisitionSource: "app_store",
    });
    await handleCommerceUninstall({ platform: "SHOPIFY", externalShopId: shop });
    const second = await linkCommerceConnection({
      tenantId: a.tenant.id, platform: "SHOPIFY", externalShopId: shop,
    });

    expect(second.id).toBe(first.id);
    expect(second.uninstalledAt).toBeNull();
    // Back to pending, NOT straight to connected: a reinstall proves nothing
    // about whether the previous subscription is still alive.
    expect(second.status).toBe("BILLING_PENDING");
    expect(await prisma.commerceConnection.count({ where: { externalShopId: shop } })).toBe(1);
  });

  it("a new connection starts BILLING_PENDING, never CONNECTED", async () => {
    const a = await newTenant();
    const conn = await linkCommerceConnection({
      tenantId: a.tenant.id, platform: "SHOPIFY", externalShopId: `${RUN}-shop-3`,
    });
    expect(conn.status).toBe("BILLING_PENDING");
  });
});

describe("scenario 9: entitlements follow VERIFIED state, nothing else", () => {
  it("an ACTIVE Shopify subscription grants exactly the Shopify capabilities", async () => {
    const { tenant, entityId } = await newTenant();
    const conn = await linkCommerceConnection({
      tenantId: tenant.id, platform: "SHOPIFY", externalShopId: `${RUN}-a1`,
    });
    use(sourceReporting(shopifySays("ACTIVE")));

    const res = await syncProviderSubscription({
      tenantId: tenant.id, billableEntityId: entityId, productKey: "shopify_connector",
      billingSource: "SHOPIFY", externalShopId: `${RUN}-a1`, commerceConnectionId: conn.id,
    });
    expect(res.entitled).toBe(true);

    const ents = await prisma.tenantEntitlement.findMany({
      where: { tenantId: tenant.id, source: "SHOPIFY_SUBSCRIPTION" },
    });
    expect(ents.map((e) => e.entitlementKey).sort()).toEqual([...SHOPIFY_FUNDED_ENTITLEMENTS].sort());
    // Each one records what paid for it.
    expect(ents.every((e) => e.fundedByBillingSource === "SHOPIFY")).toBe(true);
    expect(ents.every((e) => e.fundedByProviderSubscriptionId)).toBe(true);

    const refreshed = await prisma.commerceConnection.findUnique({ where: { id: conn.id } });
    expect(refreshed!.status).toBe("CONNECTED");
  });

  it("scenario 7: a DECLINED charge grants nothing", async () => {
    const { tenant, entityId } = await newTenant();
    use(sourceReporting(shopifySays("DECLINED")));
    const res = await syncProviderSubscription({
      tenantId: tenant.id, billableEntityId: entityId, productKey: "shopify_connector",
      billingSource: "SHOPIFY", externalShopId: `${RUN}-d1`,
    });
    expect(res.entitled).toBe(false);
    expect(await prisma.tenantEntitlement.count({
      where: { tenantId: tenant.id, source: "SHOPIFY_SUBSCRIPTION" },
    })).toBe(0);
  });

  it("scenario 8: an abandoned selection EXPIRES, and is told apart from a refusal", async () => {
    const { tenant, entityId } = await newTenant();
    use(sourceReporting(shopifySays("EXPIRED")));
    await syncProviderSubscription({
      tenantId: tenant.id, billableEntityId: entityId, productKey: "shopify_connector",
      billingSource: "SHOPIFY", externalShopId: `${RUN}-e1`,
    });
    const row = await prisma.providerSubscription.findFirst({ where: { tenantId: tenant.id } });
    expect(row!.status).toBe("EXPIRED");
    // Shopify's own word is kept, because mapping is lossy.
    expect(row!.providerStatusRaw).toBe("EXPIRED");
  });

  it("Shopify reporting NO subscription revokes - it is an answer, not silence", async () => {
    const { tenant, entityId } = await newTenant();
    use(sourceReporting(shopifySays("ACTIVE")));
    await syncProviderSubscription({
      tenantId: tenant.id, billableEntityId: entityId, productKey: "shopify_connector",
      billingSource: "SHOPIFY", externalShopId: `${RUN}-n1`,
    });
    expect(await prisma.tenantEntitlement.count({ where: { tenantId: tenant.id, source: "SHOPIFY_SUBSCRIPTION" } })).toBe(4);

    use(sourceReporting(null));
    const res = await syncProviderSubscription({
      tenantId: tenant.id, billableEntityId: entityId, productKey: "shopify_connector",
      billingSource: "SHOPIFY", externalShopId: `${RUN}-n1`,
    });
    expect(res.entitled).toBe(false);
    expect(await prisma.tenantEntitlement.count({ where: { tenantId: tenant.id, source: "SHOPIFY_SUBSCRIPTION" } })).toBe(0);
  });
});

describe("scenario 10: FROZEN pauses access without destroying anything", () => {
  it("stops paid access, keeps the record, and restores when Shopify reactivates", async () => {
    const { tenant, entityId } = await newTenant();
    const conn = await linkCommerceConnection({
      tenantId: tenant.id, platform: "SHOPIFY", externalShopId: `${RUN}-f1`,
    });
    const args = {
      tenantId: tenant.id, billableEntityId: entityId, productKey: "shopify_connector",
      billingSource: "SHOPIFY" as const, externalShopId: `${RUN}-f1`, commerceConnectionId: conn.id,
    };

    use(sourceReporting(shopifySays("ACTIVE")));
    await syncProviderSubscription(args);

    use(sourceReporting(shopifySays("FROZEN")));
    const frozen = await syncProviderSubscription(args);
    expect(frozen.entitled).toBe(false);
    const row = await prisma.providerSubscription.findFirst({ where: { tenantId: tenant.id } });
    // Not cancelled, not deleted - Shopify reactivates this itself.
    expect(row!.status).toBe("FROZEN");
    expect(row!.cancelledAt).toBeNull();

    use(sourceReporting(shopifySays("ACTIVE")));
    const restored = await syncProviderSubscription(args);
    expect(restored.entitled).toBe(true);
    expect(await prisma.tenantEntitlement.count({
      where: { tenantId: tenant.id, source: "SHOPIFY_SUBSCRIPTION" },
    })).toBe(SHOPIFY_FUNDED_ENTITLEMENTS.length);
  });
});

describe("scenario 20: a workspace with Shopify AND something else", () => {
  it("revoking Shopify leaves externally funded entitlements alone", async () => {
    const { tenant, entityId } = await newTenant();
    // Something GOTCHA bills for directly, granted by an admin override.
    await prisma.tenantEntitlement.create({
      data: {
        tenantId: tenant.id, entitlementKey: "whatsapp_channel", valueType: "BOOLEAN",
        value: true, source: "OVERRIDE",
      },
    });
    use(sourceReporting(shopifySays("ACTIVE")));
    await syncProviderSubscription({
      tenantId: tenant.id, billableEntityId: entityId, productKey: "shopify_connector",
      billingSource: "SHOPIFY", externalShopId: `${RUN}-mix`,
    });

    const revoked = await revokeShopifyEntitlements(tenant.id);
    expect(revoked).toBe(SHOPIFY_FUNDED_ENTITLEMENTS.length);

    // The WhatsApp entitlement is untouched. This is the whole reason funding
    // is recorded per row.
    const survivors = await prisma.tenantEntitlement.findMany({ where: { tenantId: tenant.id } });
    expect(survivors.map((s) => s.entitlementKey)).toContain("whatsapp_channel");
    expect(survivors.every((s) => s.source !== "SHOPIFY_SUBSCRIPTION")).toBe(true);
  });
});

describe("scenario 12: uninstall is scoped to Shopify", () => {
  it("disconnects, revokes Shopify access, and touches nothing else", async () => {
    const { tenant, entityId } = await newTenant();
    const shop = `${RUN}-u1`;
    const conn = await linkCommerceConnection({ tenantId: tenant.id, platform: "SHOPIFY", externalShopId: shop });
    await prisma.tenantEntitlement.create({
      data: {
        tenantId: tenant.id, entitlementKey: "whatsapp_channel", valueType: "BOOLEAN",
        value: true, source: "OVERRIDE",
      },
    });
    use(sourceReporting(shopifySays("ACTIVE")));
    await syncProviderSubscription({
      tenantId: tenant.id, billableEntityId: entityId, productKey: "shopify_connector",
      billingSource: "SHOPIFY", externalShopId: shop, commerceConnectionId: conn.id,
    });

    const res = await handleCommerceUninstall({ platform: "SHOPIFY", externalShopId: shop });
    expect(res.tenantId).toBe(tenant.id);
    expect(res.revoked).toBe(SHOPIFY_FUNDED_ENTITLEMENTS.length);

    const after = await prisma.commerceConnection.findUnique({ where: { id: conn.id } });
    expect(after!.status).toBe("DISCONNECTED");
    expect(after!.uninstalledAt).toBeTruthy();

    // The workspace still exists, and its non-Shopify entitlement survives.
    expect(await prisma.tenant.findUnique({ where: { id: tenant.id } })).toBeTruthy();
    const survivors = await prisma.tenantEntitlement.findMany({ where: { tenantId: tenant.id } });
    expect(survivors.map((s) => s.entitlementKey)).toEqual(["whatsapp_channel"]);

    // History survives for a support question and a later reinstall.
    const sub = await prisma.providerSubscription.findFirst({ where: { tenantId: tenant.id } });
    expect(sub!.status).toBe("CANCELLED");
    expect(sub!.cancelledAt).toBeTruthy();
  });

  it("an uninstall for an unknown shop is a no-op, not a crash", async () => {
    const res = await handleCommerceUninstall({ platform: "SHOPIFY", externalShopId: `${RUN}-nope` });
    expect(res).toEqual({ tenantId: null, revoked: 0 });
  });
});

describe("scenario 16: reconciliation repairs what no webhook reported", () => {
  it("notices a cancellation that nothing told us about", async () => {
    const { tenant, entityId } = await newTenant();
    const shop = `${RUN}-r1`;
    const conn = await linkCommerceConnection({ tenantId: tenant.id, platform: "SHOPIFY", externalShopId: shop });
    use(sourceReporting(shopifySays("ACTIVE")));
    await syncProviderSubscription({
      tenantId: tenant.id, billableEntityId: entityId, productKey: "shopify_connector",
      billingSource: "SHOPIFY", externalShopId: shop, commerceConnectionId: conn.id,
    });
    expect(await prisma.tenantEntitlement.count({ where: { tenantId: tenant.id, source: "SHOPIFY_SUBSCRIPTION" } })).toBe(4);

    // Shopify has moved on and - App Pricing sending no webhooks - nothing has
    // told us. Reconciliation is the only thing that will ever notice.
    use(sourceReporting(shopifySays("CANCELLED")));
    const summary = await reconcileProviderSubscriptions({ limit: 50 });

    expect(summary.checked).toBeGreaterThan(0);
    expect(summary.changed).toBeGreaterThan(0);
    expect(await prisma.tenantEntitlement.count({ where: { tenantId: tenant.id, source: "SHOPIFY_SUBSCRIPTION" } })).toBe(0);
  });

  it("a provider outage does NOT revoke, and does not abort the sweep", async () => {
    const { tenant, entityId } = await newTenant();
    const shop = `${RUN}-r2`;
    const conn = await linkCommerceConnection({ tenantId: tenant.id, platform: "SHOPIFY", externalShopId: shop });
    use(sourceReporting(shopifySays("ACTIVE")));
    await syncProviderSubscription({
      tenantId: tenant.id, billableEntityId: entityId, productKey: "shopify_connector",
      billingSource: "SHOPIFY", externalShopId: shop, commerceConnectionId: conn.id,
    });

    use(sourceReporting(null, { throws: true }));
    const summary = await reconcileProviderSubscriptions({ limit: 50 });

    expect(summary.failed).toBeGreaterThan(0);
    // "We could not ask" is not "they are not paying". A paying merchant keeps
    // working through a Shopify outage.
    expect(await prisma.tenantEntitlement.count({
      where: { tenantId: tenant.id, source: "SHOPIFY_SUBSCRIPTION" },
    })).toBe(SHOPIFY_FUNDED_ENTITLEMENTS.length);
  });
});

describe("scenario 14/15: repeated and out-of-order syncs settle correctly", () => {
  it("syncing the same ACTIVE state twice is idempotent", async () => {
    const { tenant, entityId } = await newTenant();
    const args = {
      tenantId: tenant.id, billableEntityId: entityId, productKey: "shopify_connector",
      billingSource: "SHOPIFY" as const, externalShopId: `${RUN}-i1`,
    };
    use(sourceReporting(shopifySays("ACTIVE")));
    const a = await syncProviderSubscription(args);
    const b = await syncProviderSubscription(args);

    expect(a.changed).toBe(true);
    // Second time nothing moved, so nothing is reported as a change.
    expect(b.changed).toBe(false);
    expect(await prisma.providerSubscription.count({ where: { tenantId: tenant.id } })).toBe(1);
    expect(await prisma.tenantEntitlement.count({
      where: { tenantId: tenant.id, source: "SHOPIFY_SUBSCRIPTION" },
    })).toBe(SHOPIFY_FUNDED_ENTITLEMENTS.length);
  });

  it("a stale ACTIVE arriving after a CANCELLED is corrected by the next verified read", async () => {
    const { tenant, entityId } = await newTenant();
    const args = {
      tenantId: tenant.id, billableEntityId: entityId, productKey: "shopify_connector",
      billingSource: "SHOPIFY" as const, externalShopId: `${RUN}-o1`,
    };
    use(sourceReporting(shopifySays("CANCELLED")));
    await syncProviderSubscription(args);

    // Out of order: an older ACTIVE view arrives late and wrongly grants.
    use(sourceReporting(shopifySays("ACTIVE")));
    await syncProviderSubscription(args);
    expect(await prisma.tenantEntitlement.count({ where: { tenantId: tenant.id, source: "SHOPIFY_SUBSCRIPTION" } })).toBe(4);

    // The provider remains the authority, so the next read settles it. This is
    // exactly why reconciliation exists rather than trusting event ordering.
    use(sourceReporting(shopifySays("CANCELLED")));
    await syncProviderSubscription(args);
    expect(await prisma.tenantEntitlement.count({ where: { tenantId: tenant.id, source: "SHOPIFY_SUBSCRIPTION" } })).toBe(0);
  });
});
