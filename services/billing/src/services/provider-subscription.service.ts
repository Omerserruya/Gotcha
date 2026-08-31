/**
 * Commerce connections, provider-owned subscriptions, and the one path that is
 * allowed to turn Shopify-funded entitlements on and off.
 *
 * The single rule
 * ---------------
 * Entitlements change ONLY after `fetchSubscription()` - an authoritative read
 * from the provider. Not after a merchant clicks a plan, not after a return URL
 * is hit, not after a webhook body arrives. Under App Pricing there are no
 * subscription webhooks at all, so this is not a belt-and-braces preference; it
 * is the only mechanism that exists.
 *
 * Why revocation is scoped rather than wholesale
 * ----------------------------------------------
 * A workspace can be paid for by more than one party. When a Shopify
 * subscription lapses, exactly the entitlements Shopify was funding must stop,
 * and the WhatsApp channel that GOTCHA bills for directly must not. That is
 * what `fundedByBillingSource` is for, and why revocation filters on it instead
 * of deleting every row for the tenant.
 */
import { prisma, setTenantEntitlement } from "@chatcenter/shared";
import type { CommercePlatform, ProviderSubscriptionStatus } from "@prisma/client";
import { getBillingSource } from "../billing-sources";
import { grantsAccess, isTerminalShopifyStatus } from "../billing-sources/shopify/status-map";

/**
 * Capabilities a Shopify subscription pays for.
 *
 * Deliberately a small, explicit list rather than "everything Shopify-shaped".
 * A capability that appears here stops working when Shopify stops paying, so
 * adding one is a commercial decision, not a refactor.
 */
export const SHOPIFY_FUNDED_ENTITLEMENTS = [
  "shopify_catalog_sync",
  "shopify_order_read",
  "shopify_order_actions",
  "shopify_storefront_widget",
] as const;

export class CrossTenantShopClaimError extends Error {
  readonly code = "COMMERCE_CONNECTION_CLAIMED_BY_ANOTHER_TENANT";
  constructor(readonly platform: CommercePlatform, readonly externalShopId: string) {
    super(
      `[commerce] ${platform} shop ${externalShopId} is already connected to a different workspace. ` +
        `Refusing to move it: a store is never re-attached on the strength of anything a user can type.`,
    );
    this.name = "CrossTenantShopClaimError";
  }
}

export interface LinkConnectionInput {
  tenantId: string;
  platform: CommercePlatform;
  /**
   * The platform's own IMMUTABLE id. For Shopify the numeric shop id, never the
   * myshopify domain - a merchant can rename a domain, and keying on it would
   * let a rename orphan the connection or, worse, let a renamed domain collide
   * with somebody else's.
   */
  externalShopId: string;
  shopDomain?: string | null;
  acquisitionSource?: string | null;
  shopifyChatInstallationId?: string | null;
}

/**
 * Attach a verified store to a workspace, or return the existing attachment.
 *
 * This is the cross-tenant guard. The database's unique index on
 * (platform, externalShopId) is the real enforcement; this function turns the
 * violation into a named error instead of a constraint failure, and - crucially
 * - never "fixes" a conflict by moving the store. A shop already claimed by
 * another workspace is an incident, not a merge.
 *
 * Reinstall is the reason this is an upsert rather than a create: the same shop
 * coming back must find its existing row rather than mint a duplicate.
 */
export async function linkCommerceConnection(input: LinkConnectionInput) {
  const existing = await prisma.commerceConnection.findUnique({
    where: {
      platform_externalShopId: {
        platform: input.platform,
        externalShopId: input.externalShopId,
      },
    },
  });

  if (existing && existing.tenantId !== input.tenantId) {
    console.error(
      `[commerce][cross-tenant] platform=${input.platform} shop=${input.externalShopId} ` +
        `is held by tenant=${existing.tenantId} and was claimed for tenant=${input.tenantId}`,
    );
    throw new CrossTenantShopClaimError(input.platform, input.externalShopId);
  }

  if (existing) {
    // A reinstall: same store, same workspace. Reconnect rather than duplicate,
    // and clear the uninstall marker.
    return prisma.commerceConnection.update({
      where: { id: existing.id },
      data: {
        status: "BILLING_PENDING",
        shopDomain: input.shopDomain ?? existing.shopDomain,
        uninstalledAt: null,
        installedAt: existing.installedAt,
        lastVerifiedAt: new Date(),
        shopifyChatInstallationId:
          input.shopifyChatInstallationId ?? existing.shopifyChatInstallationId,
      },
    });
  }

  return prisma.commerceConnection.create({
    data: {
      tenantId: input.tenantId,
      platform: input.platform,
      externalShopId: input.externalShopId,
      shopDomain: input.shopDomain ?? null,
      // BILLING_PENDING, never CONNECTED. OAuth finishing proves the merchant
      // installed the app; it proves nothing about whether anyone is paying.
      status: "BILLING_PENDING",
      acquisitionSource: input.acquisitionSource ?? null,
      shopifyChatInstallationId: input.shopifyChatInstallationId ?? null,
      lastVerifiedAt: new Date(),
    },
  });
}

export interface SyncResult {
  status: ProviderSubscriptionStatus | "NONE";
  rawStatus: string | null;
  entitled: boolean;
  changed: boolean;
}

/**
 * Ask the provider what is true, write it down, and move entitlements to match.
 *
 * The only function permitted to grant or revoke Shopify-funded access.
 *
 * A THROWN error is deliberately not treated as "no subscription". "We could
 * not ask" and "they are not paying" are different facts, and conflating them
 * would revoke a paying merchant's access during a Shopify outage.
 */
export async function syncProviderSubscription(input: {
  tenantId: string;
  billableEntityId: string;
  productKey: string;
  billingSource: "SHOPIFY";
  externalShopId: string;
  commerceConnectionId?: string | null;
  environment?: string;
}): Promise<SyncResult> {
  const source = getBillingSource(input.billingSource);
  const environment = input.environment ?? "mock";

  const observed = await source.fetchSubscription({
    tenantId: input.tenantId,
    billableEntityId: input.billableEntityId,
    productKey: input.productKey,
    externalShopId: input.externalShopId,
  });

  const status: ProviderSubscriptionStatus = observed?.status ?? "CANCELLED";
  const entitled = observed ? grantsAccess(observed.status) : false;

  const existing = await prisma.providerSubscription.findUnique({
    where: {
      billableEntityId_billingSource_productKey: {
        billableEntityId: input.billableEntityId,
        billingSource: input.billingSource,
        productKey: input.productKey,
      },
    },
  });

  const row = await prisma.providerSubscription.upsert({
    where: {
      billableEntityId_billingSource_productKey: {
        billableEntityId: input.billableEntityId,
        billingSource: input.billingSource,
        productKey: input.productKey,
      },
    },
    create: {
      tenantId: input.tenantId,
      billableEntityId: input.billableEntityId,
      billingSource: input.billingSource,
      environment,
      productKey: input.productKey,
      providerSubscriptionId: observed?.externalId ?? null,
      providerPlanHandle: observed?.planHandle ?? null,
      status,
      providerStatusRaw: observed?.rawStatus ?? null,
      trialEndsAt: observed?.trialEndsAt ?? null,
      currentPeriodStart: observed?.currentPeriodStart ?? null,
      currentPeriodEnd: observed?.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: observed?.cancelAtPeriodEnd ?? false,
      lastVerifiedAt: new Date(),
      commerceConnectionId: input.commerceConnectionId ?? null,
      metadata: (observed?.metadata ?? {}) as any,
    },
    update: {
      providerSubscriptionId: observed?.externalId ?? existing?.providerSubscriptionId ?? null,
      providerPlanHandle: observed?.planHandle ?? null,
      status,
      providerStatusRaw: observed?.rawStatus ?? null,
      trialEndsAt: observed?.trialEndsAt ?? null,
      currentPeriodStart: observed?.currentPeriodStart ?? null,
      currentPeriodEnd: observed?.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: observed?.cancelAtPeriodEnd ?? false,
      cancelledAt: isTerminalShopifyStatus(status) ? existing?.cancelledAt ?? new Date() : null,
      lastVerifiedAt: new Date(),
      metadata: (observed?.metadata ?? {}) as any,
    },
  });

  const changed = existing?.status !== status;

  if (entitled) await grantShopifyEntitlements(input.tenantId, row.id);
  else await revokeShopifyEntitlements(input.tenantId);

  if (input.commerceConnectionId) {
    await prisma.commerceConnection.update({
      where: { id: input.commerceConnectionId },
      data: { status: entitled ? "CONNECTED" : "BILLING_PENDING", lastVerifiedAt: new Date() },
    });
  }

  if (changed) {
    console.log(
      `[billing][provider-sub] tenant=${input.tenantId} product=${input.productKey} ` +
        `status=${existing?.status ?? "NONE"}->${status} raw=${observed?.rawStatus ?? "none"} entitled=${entitled}`,
    );
  }

  return { status: observed ? status : "NONE", rawStatus: observed?.rawStatus ?? null, entitled, changed };
}

/** Turn on exactly what Shopify pays for, stamped with what funded it. */
export async function grantShopifyEntitlements(tenantId: string, providerSubscriptionId: string): Promise<void> {
  for (const key of SHOPIFY_FUNDED_ENTITLEMENTS) {
    await setTenantEntitlement({
      tenantId,
      key,
      valueType: "BOOLEAN",
      value: true,
      source: "SHOPIFY_SUBSCRIPTION",
      reason: "shopify subscription verified active",
      createdBy: "billing:shopify-sync",
    });
  }
  await prisma.tenantEntitlement.updateMany({
    where: { tenantId, source: "SHOPIFY_SUBSCRIPTION" },
    data: { fundedByBillingSource: "SHOPIFY", fundedByProviderSubscriptionId: providerSubscriptionId },
  });
}

/**
 * Turn off exactly what Shopify was paying for, and nothing else.
 *
 * Scoped by `source`, so a workspace that also pays GOTCHA directly for
 * WhatsApp keeps it. Deleting by tenant would be the bug this whole funding
 * column exists to prevent.
 */
export async function revokeShopifyEntitlements(tenantId: string): Promise<number> {
  const res = await prisma.tenantEntitlement.deleteMany({
    where: { tenantId, source: "SHOPIFY_SUBSCRIPTION" },
  });
  return res.count;
}

/**
 * A verified `app/uninstalled`.
 *
 * Disconnects the commerce connection and stops Shopify-funded access. It
 * deliberately does NOT touch the workspace, the external subscription, or any
 * other channel: a merchant removing the Shopify app has said something about
 * Shopify, and nothing at all about their WhatsApp number or their GOTCHA Core
 * plan. No data is deleted here - retention is a separate, policy-driven path.
 */
export async function handleCommerceUninstall(input: {
  platform: CommercePlatform;
  externalShopId: string;
  at?: Date;
}): Promise<{ tenantId: string | null; revoked: number }> {
  const now = input.at ?? new Date();
  const conn = await prisma.commerceConnection.findUnique({
    where: {
      platform_externalShopId: { platform: input.platform, externalShopId: input.externalShopId },
    },
  });
  if (!conn) return { tenantId: null, revoked: 0 };

  await prisma.commerceConnection.update({
    where: { id: conn.id },
    data: { status: "DISCONNECTED", uninstalledAt: now },
  });

  // The Shopify subscription is no longer usable, whatever Shopify last said
  // about it. Marked CANCELLED rather than deleted so the history survives a
  // reinstall and a support question.
  await prisma.providerSubscription.updateMany({
    where: { commerceConnectionId: conn.id },
    data: { status: "CANCELLED", cancelledAt: now },
  });

  const revoked = await revokeShopifyEntitlements(conn.tenantId);

  console.log(
    `[billing][uninstall] platform=${input.platform} connection=${conn.id} tenant=${conn.tenantId} ` +
      `entitlements_revoked=${revoked}`,
  );
  return { tenantId: conn.tenantId, revoked };
}

/**
 * Periodic reconciliation against the provider's own state.
 *
 * Under App Pricing this is not a repair mechanism for missed webhooks - there
 * are no webhooks - so its cadence is the actual bound on how quickly a
 * cancellation, a freeze or a reactivation is noticed.
 *
 * One failure never stops the sweep. A Shopify outage that aborted the loop
 * would leave every subscription after the first unchecked, which is the
 * opposite of what a reconciliation job is for.
 */
export async function reconcileProviderSubscriptions(opts: { limit?: number; now?: Date } = {}): Promise<{
  checked: number;
  changed: number;
  failed: number;
}> {
  const summary = { checked: 0, changed: 0, failed: 0 };

  const rows = await prisma.providerSubscription.findMany({
    where: { billingSource: "SHOPIFY", status: { notIn: ["DECLINED", "EXPIRED"] } },
    orderBy: { lastVerifiedAt: "asc" },
    take: opts.limit ?? 100,
  });

  for (const row of rows) {
    const conn = row.commerceConnectionId
      ? await prisma.commerceConnection.findUnique({ where: { id: row.commerceConnectionId } })
      : null;
    const shopId = conn?.externalShopId;
    if (!shopId) {
      // Nothing to ask about. Not a failure to retry - it is a data gap.
      continue;
    }

    summary.checked++;
    try {
      const res = await syncProviderSubscription({
        tenantId: row.tenantId,
        billableEntityId: row.billableEntityId,
        productKey: row.productKey,
        billingSource: "SHOPIFY",
        externalShopId: shopId,
        commerceConnectionId: row.commerceConnectionId,
        environment: row.environment,
      });
      if (res.changed) {
        summary.changed++;
        console.log(
          `[billing][reconcile] mismatch repaired tenant=${row.tenantId} product=${row.productKey} ` +
            `now=${res.status} raw=${res.rawStatus ?? "none"}`,
        );
      }
    } catch (err: any) {
      summary.failed++;
      console.error(
        `[billing][reconcile] failed tenant=${row.tenantId} product=${row.productKey}: ${err?.message ?? err}`,
      );
    }
  }

  return summary;
}
