/**
 * GOTCHA Shopify Chat App — installation routes.
 *
 * Two surfaces in one file, deliberately:
 *
 *   1. PUBLIC (no GOTCHA session): the Shopify install handshake. The
 *      merchant arrives from the App Store or from Shopify admin, and the
 *      only thing we trust is what we can verify — Shopify's HMAC over the
 *      query string, and a state token we minted ourselves.
 *
 *   2. AUTHENTICATED (GOTCHA session + membership): the binding step. Which
 *      organization claims the shop is decided by the signed-in user's
 *      permissions, never by anything the browser says.
 *
 * The seam between them is a server-side continuation session held in Redis
 * and named by an HttpOnly cookie. It carries "this browser completed a
 * verified Shopify install" across a sign-in that may not have happened
 * yet. It is not authority to bind anything.
 *
 * Nothing here touches the GOTCHA Core Shopify Integration's credentials,
 * OAuth routes, or TenantIntegration rows.
 */

import { Router, Request, Response } from "express";
import {
  authenticate,
  resolveTenant,
  requireOnboardingOrActiveTenant,
  requirePermission,
  mintOAuthState,
  consumeOAuthState,
  getShopifyChatAppConfig,
  validateChatAppConfig,
  verifyShopifyQueryHmac,
  normalizeShopifyShopDomain,
  buildAppAdminLink,
  resolveAppPublicUrl,
} from "@chatcenter/shared";
import {
  recordAuthorizedInstall,
  createInstallSession,
  readInstallSession,
  discardInstallSession,
  findInstallationById,
  findLiveInstallation,
  bindInstallationToTenant,
  activationSnapshot,
  refreshVerifiedDomains,
} from "../services/shopify-chat-install.service";

const router = Router();

/** Distinct from the Core integration's "shopify" provider on purpose. */
const PROVIDER = "shopify-chat";
const INSTALL_COOKIE = "gotcha_sfy_install";

/** Scopes the CHAT app asks for. Empty in v1 — see docs/architecture. */
function chatScopes(): string {
  return (process.env.SHOPIFY_CHAT_SCOPES || "").trim();
}

/**
 * Where a merchant is sent after the install handshake.
 *
 * SHOPIFY_CHAT_APP_URL first, because the Chat app's own public URL is what
 * Shopify was told about. Falling through to `""` used to emit a bare relative
 * redirect, which happens to work in a browser and hides a missing
 * configuration until someone reads the address bar.
 */
function frontendBase(): string {
  const cfg = getShopifyChatAppConfig();
  return cfg.appUrl || resolveAppPublicUrl(process.env);
}

/** Merchant-facing failure page. Never leaks which check failed. */
function failRedirect(res: Response, code: string): void {
  const base = frontendBase();
  res.redirect(`${base}/shopify/chat/install?error=${encodeURIComponent(code)}`);
}

// ═══ PUBLIC: install handshake ═══════════════════════════════

/**
 * Entry point. Shopify sends merchants here from the App Store listing and
 * from the admin app icon, always with `?shop=`.
 *
 * The `shop` parameter is a LOOKUP KEY, never proof of anything: an
 * unauthenticated caller can name any store. Proof arrives at the callback,
 * signed by Shopify.
 */
router.get("/connectors/shopify-chat/oauth/init", async (req: Request, res: Response) => {
  const cfg = getShopifyChatAppConfig();
  const problems = validateChatAppConfig(cfg);
  if (problems.length) {
    console.error("[shopify-chat] install refused, app not configured:", problems.map((p) => p.key).join(","));
    failRedirect(res, "app_not_configured");
    return;
  }

  const shop = normalizeShopifyShopDomain(req.query.shop);
  if (!shop) {
    failRedirect(res, "invalid_shop");
    return;
  }

  // When Shopify signs the entry request, verify it. It is not always
  // present (a merchant may reach the listing link directly), so absence
  // is tolerated while a WRONG signature is not.
  if (typeof req.query.hmac === "string") {
    const ok = verifyShopifyQueryHmac(req.query as Record<string, unknown>, cfg.clientSecret);
    if (!ok) {
      console.warn("[shopify-chat] install entry rejected: bad hmac");
      failRedirect(res, "invalid_signature");
      return;
    }
  }

  // No tenant exists yet — this flow runs before the merchant has even
  // signed in to GOTCHA. The empty tenantId is what distinguishes an
  // App Store install from every other OAuth flow in this codebase.
  const { state } = mintOAuthState({
    tenantId: "",
    provider: PROVIDER,
    shop,
    flow: "shopify_app_store",
  });

  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    state,
  });
  const scope = chatScopes();
  if (scope) params.set("scope", scope);

  res.redirect(`https://${shop}/admin/oauth/authorize?${params.toString()}`);
});

/**
 * Shopify's callback. Everything is verified here, in this order:
 * signature → state (single use) → shop agreement → token exchange.
 */
router.get("/connectors/shopify-chat/oauth/callback", async (req: Request, res: Response) => {
  const cfg = getShopifyChatAppConfig();
  if (validateChatAppConfig(cfg).length) {
    failRedirect(res, "app_not_configured");
    return;
  }

  try {
    const { code, state, shop } = req.query as Record<string, string | undefined>;

    // 1. Shopify's signature over the whole query string.
    if (!verifyShopifyQueryHmac(req.query as Record<string, unknown>, cfg.clientSecret)) {
      console.warn("[shopify-chat] callback rejected: bad hmac");
      res.status(401).send("invalid_signature");
      return;
    }

    // 2. Our own state, consumed exactly once (Redis SET NX).
    const consumed = await consumeOAuthState<any>(state, PROVIDER);
    if (!consumed.ok) {
      console.warn(`[shopify-chat] callback rejected: state ${consumed.reason}`);
      res.status(400).send(consumed.reason === "replayed" ? "state_already_used" : "bad_state");
      return;
    }

    // 3. The shop that came back must be the shop we sent the merchant to.
    const returnedShop = normalizeShopifyShopDomain(shop);
    if (!returnedShop || returnedShop !== consumed.claims.shop) {
      console.warn("[shopify-chat] callback rejected: shop mismatch");
      res.status(400).send("bad_state");
      return;
    }

    // 4. Token exchange. Only meaningful when the app requests scopes; in
    //    v1 it does not, so no token is stored and there is nothing to
    //    protect, rotate or leak.
    let accessToken: string | null = null;
    let grantedScope: string | null = null;
    if (code && chatScopes()) {
      const tokenRes = await fetch(`https://${returnedShop}/admin/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code }),
      });
      if (!tokenRes.ok) {
        console.error("[shopify-chat] token exchange failed:", tokenRes.status);
        failRedirect(res, "token_exchange_failed");
        return;
      }
      const j: any = await tokenRes.json();
      accessToken = j.access_token ?? null;
      grantedScope = j.scope ?? null;
    }

    const installation = await recordAuthorizedInstall({
      shopDomain: returnedShop,
      accessToken,
      scopes: grantedScope,
    });

    const sessionToken = await createInstallSession(installation.id);
    // HttpOnly so no script — ours or a merchant's — can read it, and
    // SameSite=Lax so it survives the top-level redirect back from Shopify
    // and from the identity provider.
    res.cookie(INSTALL_COOKIE, sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 45 * 60 * 1000,
      path: "/",
    });

    res.redirect(`${frontendBase()}/shopify/chat/install?session=${encodeURIComponent(sessionToken)}`);
  } catch (err) {
    console.error("[shopify-chat] callback error:", (err as Error)?.message);
    failRedirect(res, "install_failed");
  }
});

// ═══ AUTHENTICATED: binding ══════════════════════════════════

const authed = Router();
authed.use(authenticate, resolveTenant, requireOnboardingOrActiveTenant());

/**
 * Read one cookie by name.
 *
 * Hand-rolled because `cookie-parser` is not a dependency of this repo and
 * this is the only route family that needs a cookie. Reads the raw header
 * and does not attempt to be a general cookie library.
 */
function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    const value = part.slice(idx + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

/** Resolve the continuation session from cookie first, URL as fallback. */
async function resolveInstallation(req: Request) {
  const token =
    readCookie(req, INSTALL_COOKIE) ||
    (typeof req.query.session === "string" ? req.query.session : undefined) ||
    (typeof (req.body as any)?.session === "string" ? (req.body as any).session : undefined);
  const session = await readInstallSession(token);
  if (!session) return { installation: null, token: token ?? null };
  const installation = await findInstallationById(session.installationId);
  return { installation, token: token ?? null };
}

/**
 * What the wizard needs to render step 1: which store was verified, and
 * whether it is already claimed.
 *
 * Deliberately returns no tenant id, no integration id and no token — a
 * merchant who has not bound yet must not learn anything about the
 * organization that may already own this shop.
 */
authed.get("/context", async (req: Request, res: Response) => {
  const { installation } = await resolveInstallation(req);
  if (!installation) {
    res.status(404).json({ error: "no_install_session", code: "NO_INSTALL_SESSION" });
    return;
  }
  const claimedByOther =
    !!installation.tenantId && installation.tenantId !== req.tenantId;

  res.json({
    data: {
      shopDomain: installation.shopDomain,
      status: installation.status,
      alreadyBound: !!installation.tenantId,
      boundToThisOrganization: installation.tenantId === req.tenantId,
      claimedByAnotherOrganization: claimedByOther,
      appAdminLink: buildAppAdminLink(installation.shopDomain, getShopifyChatAppConfig().appHandle),
    },
  });
});

/**
 * Claim the shop for the ACTIVE organization and guarantee its channel.
 *
 * The tenant is `req.tenantId` — resolved from the caller's session and
 * validated membership — not a field in the request body. `requirePermission`
 * then proves this user may connect channels there.
 */
authed.post(
  "/bind",
  requirePermission("channels:manage:update"),
  async (req: Request, res: Response) => {
    const { installation, token } = await resolveInstallation(req);
    if (!installation) {
      res.status(404).json({ error: "no_install_session", code: "NO_INSTALL_SESSION" });
      return;
    }

    const result = await bindInstallationToTenant({
      installationId: installation.id,
      tenantId: req.tenantId!,
      userId: req.user?.userId,
    });

    if (!result.ok) {
      const status =
        result.reason === "not_entitled" ? 403 : result.reason === "shop_taken" || result.reason === "bound_to_other_tenant" ? 409 : 404;
      res.status(status).json({ error: result.reason, code: result.reason.toUpperCase() });
      return;
    }

    const snapshot = await activationSnapshot(result.installation);
    // The continuation session has done its job. Keeping it alive after a
    // successful bind would leave a reusable handle lying around.
    await discardInstallSession(token);
    res.clearCookie(INSTALL_COOKIE, { path: "/" });

    res.status(result.created ? 201 : 200).json({
      data: {
        channelId: result.channel.id,
        channelCreated: result.created,
        shopDomain: result.installation.shopDomain,
        activation: snapshot,
      },
    });
  },
);

/**
 * Live activation state for the wizard's verify step and for the settings
 * diagnostics. Scoped to the caller's own organization.
 */
authed.get("/activation", async (req: Request, res: Response) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : undefined;
  let installation = shop ? await findLiveInstallation(shop) : null;
  if (!installation) {
    const resolved = await resolveInstallation(req);
    installation = resolved.installation;
  }
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
