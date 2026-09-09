/**
 * The single answer to "where does this workspace stand with Shopify billing?"
 *
 * WHY THIS IS DERIVED AND NOT STORED
 * ----------------------------------
 * It would be easy to keep a `shopifyBillingStatus` column and write to it from
 * six places. That column would then be wrong in a seventh, and being wrong
 * would be invisible: a stale ACTIVE grants paid capability to somebody who
 * stopped paying, and nothing about the row says it is stale.
 *
 * So the state is COMPUTED, every time, from facts that each have exactly one
 * writer:
 *
 *   • `ShopifyGrandfatherGrant` - written only by the grandfather service
 *   • `ProviderSubscription`    - written only by `syncProviderSubscription`,
 *                                 which in turn only ever writes what the
 *                                 provider told it
 *   • `CommerceConnection`      - written only by the install/uninstall paths
 *
 * Nothing here reads a query parameter, a request body, or a cached client
 * value. The only inputs are rows this system wrote from verified sources.
 *
 * THE TWO SYSTEMS STAY SEPARATE
 * -----------------------------
 * `core` and `shopify` are reported side by side and never collapsed into one
 * verdict. An active Core subscription does not appear anywhere in the Shopify
 * derivation, and a Shopify subscription does not widen Core. That separation
 * is the confirmed commercial model, and expressing it as two independent
 * fields is what stops a later "simplification" from quietly making one imply
 * the other.
 */

import { prisma } from "@chatcenter/shared";
import type { ProviderSubscriptionStatus } from "@prisma/client";
import {
  shopifyBillingEnabled,
  shopifyPlanSelectionUrl,
} from "../billing-sources/shopify/config";
import {
  SHOPIFY_CONNECTOR_PRODUCT,
  findPlanForSubscription,
  plansAvailableToShop,
  soleAvailablePlan,
} from "../billing-sources/shopify/plan-catalog";

/**
 * The domain states, and only states that correspond to something real.
 *
 * `UNRESOLVED` is included deliberately. It is not a placeholder for "we have
 * not written this yet" - it is the honest description of a deployment where
 * Shopify billing is switched off or no policy has been configured, and it
 * maps to the existing `BillingPolicy.UNRESOLVED` and to
 * `CommerceConnectionStatus.BILLING_PENDING`. Collapsing it into
 * PLAN_SELECTION_REQUIRED would send merchants to a plan page that does not
 * exist yet; collapsing it into ACTIVE would hand out capability nobody paid
 * for.
 */
export type ShopifyBillingState =
  | "UNRESOLVED"
  | "NOT_REQUIRED_GRANDFATHERED"
  | "PLAN_SELECTION_REQUIRED"
  | "APPROVAL_PENDING"
  | "ACTIVE"
  | "TRIALING"
  | "PAST_DUE"
  | "CANCELLED"
  | "FROZEN"
  /**
   * Shopify confirmed an active subscription and the local catalog cannot say
   * what it funds. A CONFIGURATION fault on our side, not a fact about the
   * merchant - which is why it is its own state rather than ERROR: an operator
   * seeing this has a specific, actionable fix (add the handle to
   * SHOPIFY_BILLING_PLAN_CATALOG), and the merchant keeps whatever was
   * previously verified in the meantime.
   */
  | "UNKNOWN_PLAN"
  | "ERROR";

/** States in which Shopify-funded capability is switched ON. */
const ENTITLING_STATES: ReadonlySet<ShopifyBillingState> = new Set([
  "NOT_REQUIRED_GRANDFATHERED",
  "ACTIVE",
  "TRIALING",
]);

export function stateGrantsShopifyAccess(state: ShopifyBillingState): boolean {
  return ENTITLING_STATES.has(state);
}

export interface ShopifyAccessSnapshot {
  tenantId: string;

  /** GOTCHA Core. Reported, never folded into the Shopify verdict. */
  core: {
    subscriptionStatus: string | null;
    planKey: string | null;
    billingSource: string | null;
  };

  /** OAuth/installation, which is independent of whether anybody has paid. */
  installation: {
    status: string;
    shopDomain: string | null;
    externalShopId: string | null;
    connectionId: string | null;
    installedAt: Date | null;
    uninstalledAt: Date | null;
  };

  shopify: {
    state: ShopifyBillingState;
    /** Machine-readable, stable, and safe to assert on. */
    reason: string;
    planKey: string | null;
    planHandle: string | null;
    providerSubscriptionId: string | null;
    /** Shopify's own word for the status. Never mapped away. */
    rawStatus: string | null;
    trialEndsAt: Date | null;
    currentPeriodEnd: Date | null;
    cancelAtPeriodEnd: boolean;
    /** True when the merchant reached the plan page and said no. */
    declined: boolean;
    /**
     * The handle Shopify reported that the catalog does not contain. Non-null
     * only in UNKNOWN_PLAN, and safe to show an operator: a plan handle is
     * configuration, never a credential.
     */
    unknownPlanHandle: string | null;
    lastVerifiedAt: Date | null;
  };

  grandfathered: {
    grantedAt: Date;
    source: string;
    reason: string;
    paidSince: Date | null;
  } | null;

  /** Shopify-funded entitlement keys currently switched on for this tenant. */
  entitlements: string[];

  /**
   * Where to send the merchant to choose a plan, or null when there is
   * nowhere to send them. Null with `PLAN_SELECTION_REQUIRED` means the app
   * handle or catalog is unconfigured - an operator problem, and one the UI
   * must state rather than dead-ending on.
   */
  planSelectionUrl: string | null;

  /** How many plans this store could be offered. 0, 1 and "several" all differ. */
  availablePlanCount: number;
}

/**
 * Map the provider's status onto our domain state.
 *
 * `PENDING` and `REQUIRES_ACTION` both become APPROVAL_PENDING: from the
 * merchant's point of view they are the same situation - Shopify has a charge
 * they have not finished approving - and the provider's own word is preserved
 * in `rawStatus` for anyone who needs the difference.
 *
 * `DECLINED` becomes PLAN_SELECTION_REQUIRED rather than a dead end, because a
 * merchant who said no can say yes later and must have somewhere to do it.
 */
function mapProviderStatus(status: ProviderSubscriptionStatus): {
  state: ShopifyBillingState;
  declined: boolean;
} {
  switch (status) {
    case "ACTIVE":
      return { state: "ACTIVE", declined: false };
    case "TRIALING":
      return { state: "TRIALING", declined: false };
    case "PAST_DUE":
      return { state: "PAST_DUE", declined: false };
    case "FROZEN":
      return { state: "FROZEN", declined: false };
    case "PENDING":
    case "REQUIRES_ACTION":
      return { state: "APPROVAL_PENDING", declined: false };
    case "DECLINED":
      return { state: "PLAN_SELECTION_REQUIRED", declined: true };
    case "CANCELLED":
    case "EXPIRED":
      return { state: "CANCELLED", declined: false };
    default:
      // A status the enum gained without this switch being updated. ERROR is
      // the fail-closed answer: it withholds capability and is visible, where
      // a default of ACTIVE would hand out access on an unknown.
      return { state: "ERROR", declined: false };
  }
}

/**
 * Compose the snapshot.
 *
 * Order matters. Grandfathering is checked BEFORE the subscription, because a
 * grandfathered merchant must never be sent to a plan page - showing one to a
 * customer who was promised they would not have to pay is the single most
 * damaging thing this flow could do.
 */
export async function getShopifyAccessSnapshot(tenantId: string): Promise<ShopifyAccessSnapshot> {
  const [link, connection, grant] = await Promise.all([
    prisma.billableEntityTenant.findUnique({
      where: { tenantId },
      select: { billableEntityId: true },
    }),
    prisma.commerceConnection.findFirst({
      where: { tenantId, platform: "SHOPIFY" },
      orderBy: { installedAt: "desc" },
    }),
    prisma.shopifyGrandfatherGrant.findUnique({ where: { tenantId } }),
  ]);

  const core = link
    ? await prisma.subscription.findUnique({
        where: { billableEntityId: link.billableEntityId },
        select: { status: true, planKey: true, billingSource: true },
      })
    : null;

  const providerSub = link
    ? await prisma.providerSubscription.findUnique({
        where: {
          billableEntityId_billingSource_productKey: {
            billableEntityId: link.billableEntityId,
            billingSource: "SHOPIFY",
            productKey: SHOPIFY_CONNECTOR_PRODUCT,
          },
        },
      })
    : null;

  const shopDomain = connection?.shopDomain ?? null;
  const activeGrant = grant && grant.status === "ACTIVE" ? grant : null;

  let state: ShopifyBillingState;
  let reason: string;
  let declined = false;

  if (!shopifyBillingEnabled()) {
    // The integration is off. Nothing is required of the merchant and nothing
    // is granted on Shopify's account - today's behaviour, unchanged.
    state = "UNRESOLVED";
    reason = "shopify_billing_disabled";
  } else if (activeGrant) {
    state = "NOT_REQUIRED_GRANDFATHERED";
    reason = activeGrant.reason;
  } else if (!providerSub) {
    state = "PLAN_SELECTION_REQUIRED";
    reason = "no_shopify_subscription";
  } else if (!providerSub.providerSubscriptionId && providerSub.status === "CANCELLED") {
    // NEVER SUBSCRIBED, which is not the same as CANCELLED.
    //
    // `syncProviderSubscription` writes a row whenever it asks Shopify, and
    // when Shopify reports nothing it records CANCELLED with no provider id -
    // that is the honest storage shape, because "we asked and there is no
    // subscription" deserves a `lastVerifiedAt` like any other answer.
    //
    // But reporting it to a merchant as "your subscription has ended" would be
    // a lie to somebody who never had one, and worse, it would strand them:
    // CANCELLED offers no route to a plan page, so a merchant who installed and
    // never subscribed would have no way to start. The absent provider id is
    // what tells the two apart.
    state = "PLAN_SELECTION_REQUIRED";
    reason = "no_shopify_subscription";
  } else if (
    (providerSub.status === "ACTIVE" || providerSub.status === "TRIALING") &&
    !findPlanForSubscription({ handle: providerSub.providerPlanHandle })
  ) {
    // Derived, not stored, so correcting the catalog repairs this the moment
    // the config lands - no migration, no backfill, no stale row to chase.
    state = "UNKNOWN_PLAN";
    reason = "plan_handle_not_in_catalog";
  } else {
    const mapped = mapProviderStatus(providerSub.status);
    state = mapped.state;
    declined = mapped.declined;
    reason = mapped.declined
      ? "merchant_declined_plan"
      : `provider_status_${String(providerSub.status).toLowerCase()}`;
  }

  const plan = findPlanForSubscription({
    handle: providerSub?.providerPlanHandle,
    name: providerSub?.planKey,
  });

  // Entitlements are read back rather than inferred from the state, so this
  // snapshot shows what the tenant ACTUALLY holds. A disagreement between the
  // two is exactly the drift worth being able to see.
  const funded = link
    ? await prisma.tenantEntitlement.findMany({
        where: { tenantId, fundedByBillingSource: "SHOPIFY" },
        select: { entitlementKey: true },
      })
    : [];

  const available = plansAvailableToShop(shopDomain);
  const sole = soleAvailablePlan(shopDomain);

  return {
    tenantId,
    core: {
      subscriptionStatus: core?.status ?? null,
      planKey: core?.planKey ?? null,
      billingSource: core?.billingSource ?? null,
    },
    installation: {
      status: connection?.status ?? "NONE",
      shopDomain,
      externalShopId: connection?.externalShopId ?? null,
      connectionId: connection?.id ?? null,
      installedAt: connection?.installedAt ?? null,
      uninstalledAt: connection?.uninstalledAt ?? null,
    },
    shopify: {
      state,
      reason,
      planKey: plan?.key ?? providerSub?.planKey ?? null,
      planHandle: providerSub?.providerPlanHandle ?? sole?.handle ?? null,
      providerSubscriptionId: providerSub?.providerSubscriptionId ?? null,
      rawStatus: providerSub?.providerStatusRaw ?? null,
      trialEndsAt: providerSub?.trialEndsAt ?? null,
      currentPeriodEnd: providerSub?.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: providerSub?.cancelAtPeriodEnd ?? false,
      declined,
      unknownPlanHandle: state === "UNKNOWN_PLAN" ? providerSub?.providerPlanHandle ?? null : null,
      lastVerifiedAt: providerSub?.lastVerifiedAt ?? null,
    },
    grandfathered: activeGrant
      ? {
          grantedAt: activeGrant.grantedAt,
          source: activeGrant.source,
          reason: activeGrant.reason,
          paidSince: activeGrant.paidSince,
        }
      : null,
    entitlements: funded.map((f) => f.entitlementKey),
    planSelectionUrl: shopDomain ? shopifyPlanSelectionUrl(shopDomain) : null,
    availablePlanCount: available.length,
  };
}

/**
 * The snapshot, shaped for a browser.
 *
 * Dates become ISO strings and nothing else changes - there is no field here
 * that is safe on the server and unsafe in a client, because none of them is a
 * token, a price, or another tenant's data. It exists so the frontend contract
 * is written down in one place instead of being whatever the route happened to
 * spread.
 */
export function serializeSnapshot(s: ShopifyAccessSnapshot) {
  const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
  return {
    core: s.core,
    installation: {
      ...s.installation,
      installedAt: iso(s.installation.installedAt),
      uninstalledAt: iso(s.installation.uninstalledAt),
    },
    shopify: {
      ...s.shopify,
      trialEndsAt: iso(s.shopify.trialEndsAt),
      currentPeriodEnd: iso(s.shopify.currentPeriodEnd),
      lastVerifiedAt: iso(s.shopify.lastVerifiedAt),
    },
    grandfathered: s.grandfathered
      ? {
          ...s.grandfathered,
          grantedAt: iso(s.grandfathered.grantedAt),
          paidSince: iso(s.grandfathered.paidSince),
        }
      : null,
    entitlements: s.entitlements,
    planSelectionUrl: s.planSelectionUrl,
    availablePlanCount: s.availablePlanCount,
    requiresPlanSelection: s.shopify.state === "PLAN_SELECTION_REQUIRED",
    grantsAccess: stateGrantsShopifyAccess(s.shopify.state),
  };
}
