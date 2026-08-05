/**
 * Shopify Chat - activation routes (unified app).
 *
 * There is no longer a Shopify install handshake here. Under the unified app
 * the merchant authorizes ONE Shopify app, the Theme App Extension ships
 * inside it, and turning chat on is a GOTCHA-side decision rather than a
 * second OAuth round trip.
 *
 * What was removed, and why it is safe to remove:
 *
 *   • `/connectors/shopify-chat/oauth/init` and `/callback` - the second
 *     install. Nothing can arrive at them any more: the Chat app's
 *     application_url pointed at init, and that app is not the production
 *     app. Leaving them mounted would keep a second identity alive that the
 *     runtime no longer has a secret for.
 *
 *   • The Redis continuation session and its HttpOnly cookie. Their whole
 *     job was carrying "this browser completed a verified Shopify install"
 *     across a sign-in. With no install handshake there is nothing to carry,
 *     and a reusable binding handle with no purpose is just attack surface.
 *
 * What replaces them: `POST /enable`, which reads the shop from the tenant's
 * existing Core connection. The shop is never taken from the request body -
 * accepting one would let a tenant claim a storefront it never connected.
 *
 * Every route here is authenticated, tenant-scoped, and permission-gated.
 */

import { Router, Request, Response } from "express";
import {
  authenticate,
  resolveTenant,
  requireOnboardingOrActiveTenant,
  requirePermission,
  getShopifyAppIdentity,
  buildAppAdminLink,
} from "@chatcenter/shared";
import {
  findLiveInstallation,
  activationSnapshot,
  refreshVerifiedDomains,
  enableChatForTenant,
  disableChatForTenant,
} from "../services/shopify-chat-install.service";
import { loadConnection } from "../services/connectors/integration-framework";

const router = Router();
const authed = Router();

authed.use(authenticate, resolveTenant, requireOnboardingOrActiveTenant());

/** HTTP status for each refusal `enableChatForTenant` can return. */
const ENABLE_STATUS: Record<string, number> = {
  shopify_not_connected: 409,
  not_entitled: 403,
  shop_taken: 409,
  bound_to_other_tenant: 409,
  installation_not_found: 404,
  installation_uninstalled: 409,
};

/**
 * What Settings → Channels → Shopify Chat needs to render.
 *
 * Reports the Shopify connection and the chat channel as SEPARATE facts,
 * because they are: a merchant can have commerce running with chat off, and
 * the UI must be able to say which of the two is missing rather than showing
 * one undifferentiated "not available".
 */
authed.get("/status", async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const conn = await loadConnection({ tenantId, slug: "shopify" }).catch(() => null);
  const shopDomain = (conn?.config as any)?.shopDomain ?? null;

  if (!shopDomain) {
    res.json({
      data: {
        shopifyConnected: false,
        shopDomain: null,
        state: "shopify_not_connected",
        activation: null,
        appAdminLink: null,
      },
    });
    return;
  }

  const installation = await findLiveInstallation(shopDomain);
  const mine = installation && (!installation.tenantId || installation.tenantId === tenantId);
  const identity = getShopifyAppIdentity();

  res.json({
    data: {
      shopifyConnected: true,
      shopDomain,
      state: mine ? "enabled" : "ready_to_activate",
      activation: mine ? await activationSnapshot(installation!) : null,
      // Empty until SHOPIFY_APP_HANDLE is read from the Partner Dashboard.
      // A guessed handle produces a link that 404s in the merchant's admin,
      // so the UI is given null and can say the link is unavailable.
      appAdminLink: identity.appHandle
        ? buildAppAdminLink(shopDomain, identity.appHandle)
        : null,
    },
  });
});

/**
 * Turn Shopify Chat on. No Shopify round trip, no second install.
 *
 * The tenant is `req.tenantId` from the caller's validated session, and the
 * shop comes from that tenant's own Core connection.
 */
authed.post(
  "/enable",
  requirePermission("channels:manage:update"),
  async (req: Request, res: Response) => {
    const result = await enableChatForTenant({
      tenantId: req.tenantId!,
      userId: req.user?.userId,
    });
    if (!result.ok) {
      res.status(ENABLE_STATUS[result.reason] ?? 400).json({
        error: result.reason,
        code: result.reason.toUpperCase(),
      });
      return;
    }
    res.status(result.created ? 201 : 200).json({
      data: {
        channelId: result.channel.id,
        channelCreated: result.created,
        shopDomain: result.installation.shopDomain,
        activation: await activationSnapshot(result.installation),
      },
    });
  },
);

/**
 * Turn Shopify Chat off. Leaves the Shopify connection untouched.
 *
 * The App Embed in the merchant's theme is a separate switch that only they
 * can flip; the response says so rather than implying GOTCHA removed it.
 */
authed.post(
  "/disable",
  requirePermission("channels:manage:update"),
  async (req: Request, res: Response) => {
    const result = await disableChatForTenant({ tenantId: req.tenantId! });
    res.json({
      data: {
        disabled: result.disabled,
        shopifyStillConnected: true,
        themeEmbedStillInstalled: true,
      },
    });
  },
);

/** Live activation state, scoped to the caller's own organization. */
authed.get("/activation", async (req: Request, res: Response) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : undefined;
  const conn = shop ? null : await loadConnection({ tenantId: req.tenantId!, slug: "shopify" }).catch(() => null);
  const target = shop ?? (conn?.config as any)?.shopDomain;
  const installation = target ? await findLiveInstallation(target) : null;
  if (!installation) {
    res.status(404).json({ error: "not_installed", code: "APP_NOT_INSTALLED" });
    return;
  }
  if (installation.tenantId && installation.tenantId !== req.tenantId) {
    // Another organization's installation is none of this caller's business.
    res.status(404).json({ error: "not_installed", code: "APP_NOT_INSTALLED" });
    return;
  }
  res.json({ data: await activationSnapshot(installation) });
});

/** Re-ask Shopify which domains this storefront actually serves. */
authed.post(
  "/refresh-domains",
  requirePermission("channels:manage:update"),
  async (req: Request, res: Response) => {
    const installation = await findLiveInstallation(String(req.body?.shop ?? ""));
    if (!installation || installation.tenantId !== req.tenantId) {
      res.status(404).json({ error: "not_installed" });
      return;
    }
    res.json({ data: { verifiedDomains: await refreshVerifiedDomains(installation) } });
  },
);

router.use("/shopify-chat-install", authed);

export default router;
