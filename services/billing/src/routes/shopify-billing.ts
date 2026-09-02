/**
 * Shopify billing: state, plan selection, and the verified return.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE
 * ----------------------------------------
 * Arriving at the return URL is not proof of anything.
 *
 * Shopify sends the merchant's BROWSER back to us after plan approval. A
 * browser can be sent anywhere by anyone: a merchant who declined can open the
 * return URL from history, a curious one can type it, and a hostile one can
 * share it. So `/billing/shopify/complete` ignores every query parameter it is
 * given as evidence and asks Shopify directly what the subscription is. The
 * parameters are read only as a HINT about which store to ask about, and even
 * that is cross-checked against the connection the authenticated session owns.
 *
 * The verification itself is `syncProviderSubscription`, which is the only
 * function permitted to move Shopify-funded entitlements. This route does not
 * grant anything; it asks that function to, and reports what came back.
 *
 * WHY PLAN SELECTION IS A REDIRECT AND NOT A PURCHASE
 * ---------------------------------------------------
 * GOTCHA never creates a charge here. Under App Pricing the merchant chooses
 * and approves on Shopify's own hosted page, which is what the App Store
 * requires and what keeps us out of the position of having a local record of a
 * charge Shopify has not confirmed.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import {
  authenticate,
  resolveTenant,
  requirePermission,
  requireSystemAdmin,
  prisma,
} from "@chatcenter/shared";
import {
  getShopifyAccessSnapshot,
  serializeSnapshot,
} from "../services/shopify-billing-state.service";
import { syncProviderSubscription } from "../services/provider-subscription.service";
import {
  ensureGrandfatherGrant,
  assessGrandfatherEligibility,
  overrideGrandfatherGrant,
  revokeGrandfatherGrant,
  getActiveGrandfatherGrant,
} from "../services/shopify-grandfather.service";
import {
  shopifyBillingAppliesToShop,
  shopifyBillingEnabled,
  shopifyBillingEnv,
  shopifyPlanSelectionUrl,
} from "../billing-sources/shopify/config";
import {
  SHOPIFY_CONNECTOR_PRODUCT,
  plansAvailableToShop,
} from "../billing-sources/shopify/plan-catalog";

const router = Router();

/**
 * Resolve the Shopify connection this workspace owns.
 *
 * Takes the tenant from the validated session and NEVER from the request. This
 * is the same separation the install flow makes: which store is a question
 * Shopify answers, which workspace is a question the session answers, and a
 * parameter is not allowed to answer either.
 */
async function connectionForTenant(tenantId: string) {
  return prisma.commerceConnection.findFirst({
    where: { tenantId, platform: "SHOPIFY" },
    orderBy: { installedAt: "desc" },
  });
}

async function billableEntityIdForTenant(tenantId: string): Promise<string | null> {
  const link = await prisma.billableEntityTenant.findUnique({
    where: { tenantId },
    select: { billableEntityId: true },
  });
  return link?.billableEntityId ?? null;
}

// ─── Read state ──────────────────────────────────────────────────────────

/**
 * Everything the UI needs to render a Shopify billing state.
 *
 * Readable by any authenticated member, like `/billing/subscription`: knowing
 * whether your own workspace owes Shopify money is not privileged information,
 * and hiding it behind the manage permission would leave most users staring at
 * a disabled feature with no explanation.
 */
router.get("/billing/shopify/state", authenticate, resolveTenant, async (req: Request, res: Response) => {
  const snapshot = await getShopifyAccessSnapshot(req.tenantId!);
  res.json({ data: serializeSnapshot(snapshot) });
});

/**
 * The plans this store could be offered.
 *
 * Returns identifiers and our own metadata only - no price, no currency, no
 * trial length. Those belong to Shopify and are shown on Shopify's page. A
 * price rendered here would be a second copy of a number we do not own.
 */
router.get("/billing/shopify/plans", authenticate, resolveTenant, async (req: Request, res: Response) => {
  const connection = await connectionForTenant(req.tenantId!);
  const plans = plansAvailableToShop(connection?.shopDomain ?? null).map((p) => ({
    key: p.key,
    productKey: p.productKey,
    interval: p.interval,
    rank: p.rank,
    entitlements: p.entitlements,
    visibility: p.visibility,
  }));
  res.json({ data: { plans } });
});

// ─── Begin plan selection ────────────────────────────────────────────────

/**
 * Where to send the merchant to choose and approve a plan.
 *
 * Returns a URL rather than redirecting so the caller can decide how to
 * navigate, and so a merchant who is already grandfathered gets a refusal with
 * a reason instead of a trip to a plan page they must never see.
 */
router.post(
  "/billing/shopify/plan-selection",
  authenticate,
  resolveTenant,
  requirePermission("settings:billing:manage"),
  async (req: Request, res: Response) => {
    const tenantId = req.tenantId!;

    if (!shopifyBillingEnabled()) {
      res.status(503).json({
        error: "shopify_billing_disabled",
        detail: "Shopify billing is not switched on for this deployment.",
      });
      return;
    }

    const snapshot = await getShopifyAccessSnapshot(tenantId);

    if (snapshot.shopify.state === "NOT_REQUIRED_GRANDFATHERED") {
      // Not an error the merchant caused, and not something to route around.
      res.status(409).json({
        error: "shopify_billing_not_required",
        detail: "This workspace keeps its existing GOTCHA billing and does not need a Shopify plan.",
      });
      return;
    }

    const connection = await connectionForTenant(tenantId);
    if (!connection || connection.status === "DISCONNECTED") {
      // Billing cannot precede installation: there is no store to bill for.
      res.status(409).json({
        error: "shopify_not_connected",
        detail: "Connect the Shopify store before choosing a plan.",
      });
      return;
    }

    // The allowlist, read from the CONNECTION rather than the request. A shop
    // this deployment has not opted in must never be sent to a plan page.
    if (!shopifyBillingAppliesToShop(connection.shopDomain)) {
      res.status(409).json({
        error: "shopify_billing_not_enabled_for_shop",
        detail: "Shopify billing is not enabled for this store on this deployment.",
      });
      return;
    }

    const url = shopifyPlanSelectionUrl(connection.shopDomain ?? "");
    if (!url) {
      res.status(503).json({
        error: "shopify_plan_selection_unavailable",
        detail:
          "No Shopify plan-selection page is configured yet. This is a server configuration gap, " +
          "not something the merchant can resolve.",
      });
      return;
    }

    console.log(
      `[billing][shopify] plan selection started tenant=${tenantId} connection=${connection.id} ` +
        `state=${snapshot.shopify.state}`,
    );
    res.json({ data: { url, state: snapshot.shopify.state } });
  },
);

// ─── The verified return ─────────────────────────────────────────────────

/**
 * Called by `/integrations/shopify/billing/complete` after Shopify sends the
 * merchant back.
 *
 * Everything that matters happens server-side:
 *
 *   1. the store is taken from the connection this SESSION owns, not from the
 *      `shop` parameter Shopify appended;
 *   2. `syncProviderSubscription` asks Shopify what the subscription actually
 *      is, and writes down what it says;
 *   3. entitlements move to match, inside that same function;
 *   4. the answer returned is the freshly computed state, so the page renders
 *      what was verified rather than what was hoped.
 *
 * A merchant who declined gets `PLAN_SELECTION_REQUIRED` back and no
 * entitlements - the same answer as never having visited, which is correct,
 * because declining and never arriving are commercially identical.
 */
router.post(
  "/billing/shopify/complete",
  authenticate,
  resolveTenant,
  requirePermission("settings:billing:manage"),
  async (req: Request, res: Response) => {
    const tenantId = req.tenantId!;

    const connection = await connectionForTenant(tenantId);
    if (!connection || connection.status === "DISCONNECTED") {
      res.status(409).json({
        error: "shopify_not_connected",
        detail: "There is no connected Shopify store for this workspace.",
      });
      return;
    }

    // The `shop` Shopify appends is compared, never trusted. A mismatch means
    // the merchant returned into a different workspace's tab, and continuing
    // would verify one store's subscription into another store's workspace.
    const claimedShop = typeof req.query.shop === "string" ? req.query.shop.trim().toLowerCase() : null;
    if (claimedShop && connection.shopDomain && claimedShop !== connection.shopDomain.toLowerCase()) {
      console.warn(
        `[billing][shopify] return shop mismatch tenant=${tenantId} connection=${connection.id}`,
      );
      res.status(409).json({
        error: "shopify_shop_mismatch",
        detail: "This billing return does not belong to the store connected to this workspace.",
      });
      return;
    }

    // Same gate on the return path. Without it, a shop outside the allowlist
    // that somehow reached a Shopify plan page could still have a subscription
    // verified and entitlements granted here.
    if (!shopifyBillingAppliesToShop(connection.shopDomain)) {
      res.status(409).json({
        error: "shopify_billing_not_enabled_for_shop",
        detail: "Shopify billing is not enabled for this store on this deployment.",
      });
      return;
    }

    const billableEntityId = await billableEntityIdForTenant(tenantId);
    if (!billableEntityId) {
      res.status(409).json({
        error: "no_billable_entity",
        detail: "This workspace has no billing account to attach a subscription to.",
      });
      return;
    }

    try {
      const result = await syncProviderSubscription({
        tenantId,
        billableEntityId,
        productKey: SHOPIFY_CONNECTOR_PRODUCT,
        billingSource: "SHOPIFY",
        externalShopId: connection.externalShopId,
        commerceConnectionId: connection.id,
        environment: shopifyBillingEnv(),
      });

      const snapshot = await getShopifyAccessSnapshot(tenantId);
      console.log(
        `[billing][shopify] return verified tenant=${tenantId} status=${result.status} ` +
          `entitled=${result.entitled} state=${snapshot.shopify.state}`,
      );
      res.json({ data: serializeSnapshot(snapshot) });
    } catch (err: any) {
      // "We could not ask Shopify" is NOT "they are not paying". Returning 502
      // and changing nothing keeps a paying merchant's access intact through a
      // Shopify outage; the reconciliation job will catch up.
      console.error(`[billing][shopify] verification failed tenant=${tenantId}: ${err?.message}`);
      res.status(502).json({
        error: "shopify_verification_failed",
        detail: "Could not confirm the subscription with Shopify. Your access is unchanged; please retry shortly.",
      });
    }
  },
);

// ─── Grandfathering ──────────────────────────────────────────────────────

/**
 * Evaluate and, if earned, record grandfathered eligibility.
 *
 * Idempotent: the underlying service returns a standing grant rather than
 * deciding again. Exposed to the tenant's own billing manager because it takes
 * NO input - eligibility is computed entirely from our own records, so there is
 * nothing here for a caller to influence.
 */
router.post(
  "/billing/shopify/grandfather/evaluate",
  authenticate,
  resolveTenant,
  requirePermission("settings:billing:manage"),
  async (req: Request, res: Response) => {
    const result = await ensureGrandfatherGrant({ tenantId: req.tenantId! });
    const snapshot = await getShopifyAccessSnapshot(req.tenantId!);
    res.json({
      data: {
        granted: !!result.grant,
        created: result.created,
        reason: result.reason,
        state: serializeSnapshot(snapshot),
      },
    });
  },
);

/**
 * What the rules say, without acting on it.
 *
 * SYSTEM_ADMIN only - it exposes the evidence blob, which names subscription
 * and payment dates that a tenant user has no reason to inspect through this
 * surface.
 */
router.get(
  "/admin/billing/shopify/grandfather/:tenantId",
  authenticate,
  requireSystemAdmin(),
  async (req: Request, res: Response) => {
    const tenantId = String(req.params.tenantId);
    const [assessment, grant] = await Promise.all([
      assessGrandfatherEligibility({ tenantId }),
      getActiveGrandfatherGrant(tenantId),
    ]);
    res.json({ data: { assessment, grant } });
  },
);

/**
 * Grant grandfathering on an admin's authority.
 *
 * SYSTEM_ADMIN only, and `approvedBy` is taken from the AUTHENTICATED USER
 * rather than the body. An override whose approver could be typed by the caller
 * would be an audit trail that records whatever the caller wanted it to.
 */
router.post(
  "/admin/billing/shopify/grandfather/:tenantId",
  authenticate,
  requireSystemAdmin(),
  async (req: Request, res: Response) => {
    const tenantId = String(req.params.tenantId);
    const note = typeof req.body?.note === "string" ? req.body.note : undefined;
    const approvedBy = req.user?.userId;
    if (!approvedBy) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    const grant = await overrideGrandfatherGrant({ tenantId, approvedBy, note });
    res.json({ data: { grant } });
  },
);

/** Withdraw a grant. SYSTEM_ADMIN only, attributable, and never silent. */
router.delete(
  "/admin/billing/shopify/grandfather/:tenantId",
  authenticate,
  requireSystemAdmin(),
  async (req: Request, res: Response) => {
    const tenantId = String(req.params.tenantId);
    const revokedBy = req.user?.userId;
    if (!revokedBy) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    const reason = typeof req.body?.reason === "string" && req.body.reason.trim()
      ? req.body.reason.trim()
      : "admin_revocation";
    const grant = await revokeGrandfatherGrant({ tenantId, revokedBy, reason });
    if (!grant) {
      res.status(404).json({ error: "grant_not_found" });
      return;
    }
    res.json({ data: { grant } });
  },
);

export default router;
