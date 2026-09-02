/**
 * What happens to BILLING the moment a Shopify store finishes OAuth.
 *
 * ORDERING, AND WHY IT IS THIS WAY ROUND
 * --------------------------------------
 * OAuth and store linking come FIRST, always. This function runs after both
 * have already succeeded, and it can only ever decide what the merchant is
 * shown NEXT - it can never prevent an installation from completing. That is a
 * requirement rather than a preference: an app that put a payment screen in
 * front of Shopify's own authorization would fail review, and a merchant whose
 * install half-completed because our billing service was down would be left
 * with a store that is authorized on Shopify's side and unknown on ours.
 *
 * So every failure path here is soft. If the policy cannot be resolved, the
 * store is still connected, the entitlements simply stay off, and the merchant
 * lands on the ordinary connected screen where the state is explained.
 *
 * THE THREE SCENARIOS, ALL HANDLED BY ONE PATH
 * --------------------------------------------
 * A pre-publication customer, a new customer who found us directly, and a
 * customer who came from the App Store all arrive here identically. That is
 * deliberate: the confirmed model says billing must NOT depend on acquisition
 * source. `acquisitionSource` is recorded because it is genuinely useful
 * afterwards and cannot be reconstructed later - but nothing in the decision
 * below reads it.
 *
 * The only thing that separates them is evidence: whether the workspace was
 * already paying GOTCHA before the listing published. That is a fact about our
 * own database, and it is what `ensureGrandfatherGrant` measures.
 */

import { prisma, setTenantEntitlement } from "@chatcenter/shared";
import {
  SHOPIFY_FUNDED_ENTITLEMENTS,
  linkCommerceConnection,
  syncProviderSubscription,
} from "./provider-subscription.service";
import { ensureGrandfatherGrant } from "./shopify-grandfather.service";
import {
  getShopifyAccessSnapshot,
  stateGrantsShopifyAccess,
  type ShopifyBillingState,
} from "./shopify-billing-state.service";
import { resolveAndRecordBillingPolicy } from "./billing-policy-resolver.service";
import { shopifyBillingEnabled, shopifyBillingEnv } from "../billing-sources/shopify/config";
import { SHOPIFY_CONNECTOR_PRODUCT } from "../billing-sources/shopify/plan-catalog";

export interface ShopifyConnectedInput {
  tenantId: string;
  /** Shopify's numeric shop id. Immutable; never the domain. */
  externalShopId: string;
  shopDomain?: string | null;
  /** "app_store" | "in_app_connect" | "admin". Recorded, never decisive. */
  acquisitionSource?: string | null;
  /** From verified shop data, when we have it. Gates automatic grandfathering. */
  isDevelopmentStore?: boolean;
}

export interface ShopifyConnectedResult {
  connectionId: string;
  state: ShopifyBillingState;
  grandfathered: boolean;
  requiresPlanSelection: boolean;
  /** Shopify's hosted plan page, when one applies and is configured. */
  planSelectionUrl: string | null;
}

/**
 * Turn on the capabilities a grandfathered workspace is entitled to.
 *
 * Stamped `SHOPIFY_GRANDFATHERED`, not `SHOPIFY_SUBSCRIPTION`, so that the
 * revocation path for a lapsed subscription cannot reach them. They are funded
 * by `EXEMPT`: nobody is being charged for these, and recording them as
 * GOTCHA_EXTERNAL would misattribute them to a Core plan that does not include
 * them.
 */
export async function grantGrandfatheredShopifyEntitlements(tenantId: string): Promise<void> {
  for (const key of SHOPIFY_FUNDED_ENTITLEMENTS) {
    await setTenantEntitlement({
      tenantId,
      key,
      valueType: "BOOLEAN",
      value: true,
      source: "SHOPIFY_GRANDFATHERED",
      reason: "grandfathered: paying GOTCHA before the Shopify listing published",
      createdBy: "billing:shopify-grandfather",
    });
  }
  await prisma.tenantEntitlement.updateMany({
    where: { tenantId, source: "SHOPIFY_GRANDFATHERED" },
    data: { fundedByBillingSource: "EXEMPT", fundedByProviderSubscriptionId: null },
  });
}

/**
 * Record the connection, decide the billing consequence, and report it.
 *
 * Returns what the caller should do next. It does NOT redirect, render, or
 * throw on a billing problem - the install has already succeeded by the time
 * this runs, and nothing here is allowed to retract that.
 */
export async function onShopifyConnected(
  input: ShopifyConnectedInput,
): Promise<ShopifyConnectedResult> {
  // 1. The connection itself. This throws on a cross-tenant claim, and that one
  //    IS allowed to propagate: a store held by another workspace must never be
  //    silently moved, and the caller has to see it.
  const connection = await linkCommerceConnection({
    tenantId: input.tenantId,
    platform: "SHOPIFY",
    externalShopId: input.externalShopId,
    shopDomain: input.shopDomain ?? null,
    acquisitionSource: input.acquisitionSource ?? null,
  });

  // 2. With billing switched off, the connection is simply live - today's
  //    behaviour for every existing merchant, unchanged. Nothing is granted on
  //    Shopify's account because Shopify is not in the picture.
  if (!shopifyBillingEnabled()) {
    await prisma.commerceConnection.update({
      where: { id: connection.id },
      data: { status: "CONNECTED" },
    });
    return {
      connectionId: connection.id,
      state: "UNRESOLVED",
      grandfathered: false,
      requiresPlanSelection: false,
      planSelectionUrl: null,
    };
  }

  // 3. Grandfathering, before anything that could send them to a plan page.
  //    Idempotent - a reinstall finds the standing grant rather than
  //    re-deciding against whatever flags are set today.
  const grandfather = await ensureGrandfatherGrant({
    tenantId: input.tenantId,
    isDevelopmentStore: input.isDevelopmentStore,
  });

  if (grandfather.grant) {
    await grantGrandfatheredShopifyEntitlements(input.tenantId);
    await prisma.commerceConnection.update({
      where: { id: connection.id },
      data: { status: "CONNECTED" },
    });
    await recordPolicy(input, connection.id);
    const snapshot = await getShopifyAccessSnapshot(input.tenantId);
    console.log(
      `[billing][shopify] connected tenant=${input.tenantId} grandfathered=true ` +
        `connection=${connection.id}`,
    );
    return {
      connectionId: connection.id,
      state: snapshot.shopify.state,
      grandfathered: true,
      requiresPlanSelection: false,
      planSelectionUrl: null,
    };
  }

  // 4. Not grandfathered. Ask Shopify whether this store already has a
  //    subscription - a reinstall, or a merchant who paid before reconnecting -
  //    so that somebody who is already paying is never sent to pay again.
  const link = await prisma.billableEntityTenant.findUnique({
    where: { tenantId: input.tenantId },
    select: { billableEntityId: true },
  });

  if (link) {
    try {
      await syncProviderSubscription({
        tenantId: input.tenantId,
        billableEntityId: link.billableEntityId,
        productKey: SHOPIFY_CONNECTOR_PRODUCT,
        billingSource: "SHOPIFY",
        externalShopId: input.externalShopId,
        commerceConnectionId: connection.id,
        environment: shopifyBillingEnv(),
      });
    } catch (err: any) {
      // Could not ask. NOT the same as "not paying": leaving the state alone
      // means the merchant keeps whatever they had, and reconciliation will
      // settle it. The install is unaffected either way.
      console.warn(
        `[billing][shopify] post-install verification failed tenant=${input.tenantId}: ${err?.message}`,
      );
    }
  }

  await recordPolicy(input, connection.id);
  const snapshot = await getShopifyAccessSnapshot(input.tenantId);

  // A store whose subscription is confirmed live is CONNECTED; anything else
  // stays BILLING_PENDING, which is the honest description of a store that is
  // installed and authorized but not yet paid for.
  await prisma.commerceConnection.update({
    where: { id: connection.id },
    data: {
      status: stateGrantsShopifyAccess(snapshot.shopify.state) ? "CONNECTED" : "BILLING_PENDING",
    },
  });

  console.log(
    `[billing][shopify] connected tenant=${input.tenantId} state=${snapshot.shopify.state} ` +
      `connection=${connection.id} planSelection=${snapshot.shopify.state === "PLAN_SELECTION_REQUIRED"}`,
  );

  return {
    connectionId: connection.id,
    state: snapshot.shopify.state,
    grandfathered: false,
    requiresPlanSelection: snapshot.shopify.state === "PLAN_SELECTION_REQUIRED",
    planSelectionUrl:
      snapshot.shopify.state === "PLAN_SELECTION_REQUIRED" ? snapshot.planSelectionUrl : null,
  };
}

/**
 * Write the policy audit row, and never let it break an install.
 *
 * The decision is worth recording and is worth nothing at all compared to a
 * completed installation, so a failure here is logged and swallowed.
 */
async function recordPolicy(input: ShopifyConnectedInput, commerceConnectionId: string) {
  try {
    await resolveAndRecordBillingPolicy({
      tenantId: input.tenantId,
      commerceConnectionId,
      acquisitionSource: input.acquisitionSource ?? null,
      decidedBy: "billing:post-install",
    });
  } catch (err: any) {
    console.warn(`[billing][shopify] policy record failed tenant=${input.tenantId}: ${err?.message}`);
  }
}
