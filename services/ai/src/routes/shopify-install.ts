/**
 * Shopify installation - the Shopify-owned entry point.
 *
 *   GET  /connectors/shopify/install          PUBLIC. Shopify's signed app entry.
 *   GET  /connectors/shopify/install/start    Authed. "Connect Shopify" button.
 *   GET  /connectors/shopify/install/pending  Authed. What is waiting to be claimed.
 *   POST /connectors/shopify/install/claim    Authed. Bind a pending install.
 *
 * What was wrong before
 * ---------------------
 * Installation started on a GOTCHA screen with a text box: the merchant typed
 * `my-store.myshopify.com` and we redirected to whatever they typed. Three
 * separate problems in one flow:
 *
 *   • App Store requirement 2.3.1 forbids asking for the shop domain at all -
 *     Shopify identifies the store, we do not.
 *   • Requirement 2.3.2 requires OAuth BEFORE any app UI, and the production
 *     `application_url` pointed at GOTCHA's dashboard root, so a merchant
 *     installing from Shopify landed on a login screen instead.
 *   • A typed host is an unauthenticated claim. Everything downstream - the
 *     authorize redirect, the shop we bound - was built from it.
 *
 * The order now
 * -------------
 *   Connect Shopify (authed) → Shopify listing/store picker → Shopify signs an
 *   app-entry request → we verify it → authorize redirect → callback.
 *
 * No GOTCHA screen appears between the merchant leaving for Shopify and the
 * consent screen, and the shop is only ever a value Shopify signed.
 *
 * The workspace question is answered separately from the store question; see
 * services/shopify-install-intent.service.ts for why those two must not be
 * the same answer.
 */

import { Router, type Request, type Response } from "express";
import {
  authenticate,
  resolveTenant,
  requireActiveTenant,
  requireOnboardingOrActiveTenant,
  requirePermission,
  mintOAuthState,
  getShopifyAppIdentity,
  shopifyApiVersion,
  resolveAppPublicUrl,
  verifyAppEntryHmac,
  buildShopifyAuthorizeUrl,
  singleValue,
  parseSessionCookie,
} from "@chatcenter/shared";
import {
  createInstallIntent,
  readInstallIntent,
  discardInstallIntent,
  peekPendingConnection,
  consumePendingConnection,
  INSTALL_INTENT_COOKIE,
  INSTALL_INTENT_TTL_SECONDS,
} from "../services/shopify-install-intent.service";
import {
  SHOPIFY_OAUTH_SCOPES,
  linkShopifyShopToTenant,
} from "../services/shopify-connection-link.service";
import { resolveShopifyBillingOutcome } from "../services/shopify-billing-bridge.service";

const router = Router();

const canConnectSystems = requirePermission(
  "integrations:connections:connect",
  "business-systems:connections:connect",
);

/** Recognised `flow` values - the same allow-list the OAuth callback uses. */
const KNOWN_FLOWS = new Set(["onboarding", "settings_business_systems"]);
function parseFlow(raw: unknown): string | undefined {
  const v = singleValue(raw);
  return v && KNOWN_FLOWS.has(v) ? v : undefined;
}

/**
 * Where a REFUSED install sends the browser.
 *
 * A fixed internal path on our own origin, built from `resolveAppPublicUrl`.
 * Never a URL from the request: the install entry point is public and
 * unauthenticated, which is exactly the shape an open redirect wants.
 */
function installErrorRedirect(reason: string): string {
  // `resolveAppPublicUrl` THROWS when FRONTEND_URL is unset in production.
  // On this route that would turn a rejected install into an unhandled 500,
  // which is a worse answer than a relative redirect - and it would happen on
  // the PUBLIC entry point, where the caller may be Shopify.
  let base = "";
  try {
    base = resolveAppPublicUrl(process.env);
  } catch {
    base = "";
  }
  return `${base}/settings/business-systems?shopify_install_error=${encodeURIComponent(reason)}`;
}

/**
 * Read the intent handle from the raw Cookie header.
 *
 * `req.cookies` does not exist here - this service does not mount
 * cookie-parser, and adding a dependency to read one cookie is not a trade
 * worth making. `parseSessionCookie` is the codec already used for the app
 * session: it rejects a duplicated cookie name outright rather than picking
 * one, which is the behaviour we want when two intents disagree about the
 * workspace.
 *
 * Throws on a malformed header, so it is wrapped: a bad cookie means "no
 * intent" (fall through to the anonymous path), never a failed install.
 */
export function readIntentCookie(req: Request): string | null {
  try {
    return parseSessionCookie(req.headers?.cookie, INSTALL_INTENT_COOKIE);
  } catch {
    return null;
  }
}

// ─── 1. The button ───────────────────────────────────────────

/**
 * "Connect Shopify", pressed by a signed-in user.
 *
 * Returns the Shopify-owned install URL and records a server-side intent so
 * the callback knows which workspace started this. The intent handle goes
 * back as an HttpOnly cookie, not in the URL: a handle in the URL travels
 * through Shopify's redirect chain and into referrer headers and logs.
 *
 * There is deliberately NO `shop` parameter. Shopify picks the store.
 */
router.get(
  "/connectors/shopify/install/start",
  authenticate,
  resolveTenant,
  requireOnboardingOrActiveTenant(),
  canConnectSystems,
  async (req: Request, res: Response) => {
    const identity = getShopifyAppIdentity();
    if (!identity.installUrl) {
      // The App Store listing is not published yet, so there is no
      // Shopify-owned page to send this merchant to.
      //
      // This route ONLY is unavailable. Installation from the Partner
      // Dashboard, the public install handler, OAuth, the callback, existing
      // connections and reauthorization are all unaffected - none of them
      // reads installUrl.
      //
      // Deliberately NOT a fallback to a shop-domain prompt. That is the
      // thing App Store requirement 2.3.1 forbids, and re-adding it "just
      // until the listing is live" is how it would come back permanently.
      res.status(503).json({
        error: "shopify_install_not_available",
        detail:
          "New Shopify connections are not available yet. The GOTCHA app is " +
          "pending its Shopify App Store listing; once it is published this " +
          "button will take you to Shopify to choose your store.",
      });
      return;
    }

    const handle = await createInstallIntent({
      tenantId: req.tenantId!,
      userId: (req as any).user?.userId,
      flow: parseFlow(req.query.flow),
    });

    // SameSite=Lax survives the top-level GET navigation Shopify performs back
    // to our install entry point, and blocks the cookie on cross-site POSTs
    // and subresource loads. Secure in production; a dev stack on plain HTTP
    // would drop a Secure cookie and lose the intent silently.
    res.cookie(INSTALL_INTENT_COOKIE, handle, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: INSTALL_INTENT_TTL_SECONDS * 1000,
      path: "/",
    });

    res.json({ url: identity.installUrl });
  },
);

// ─── 2. The public install handler ───────────────────────────

/**
 * Shopify's signed app-entry request. PUBLIC by requirement.
 *
 * No `authenticate`, no `resolveTenant`: a merchant installing from the App
 * Store has no GOTCHA session yet, and requiring one here is precisely the
 * "login screen before OAuth" that requirement 2.3.2 prohibits.
 *
 * Everything this route trusts comes from `verifyAppEntryHmac`, which
 * refuses a missing, malformed, duplicated, stale or unsigned request. On
 * success it hands back a shop domain in Shopify's exact canonical form, and
 * that value - not anything from the query - is what builds the redirect.
 */
router.get("/connectors/shopify/install", async (req: Request, res: Response) => {
  const identity = getShopifyAppIdentity();

  const verified = verifyAppEntryHmac(
    req.query as Record<string, unknown>,
    identity.clientSecret,
  );
  if (!verified.ok) {
    // Logged precisely, answered vaguely. `reason` distinguishes a forged
    // signature from a stale one for us; the browser learns only that the
    // request was rejected. The shop is deliberately NOT logged on an invalid
    // HMAC - an unverified value is not a fact worth recording - and the hmac
    // itself is never logged at all.
    console.warn(`[shopify install] app entry rejected: ${verified.reason}`);
    res.redirect(installErrorRedirect("invalid_request"));
    return;
  }
  const shop = verified.shop;

  if (!identity.clientId || !identity.redirectUri) {
    console.error("[shopify install] SHOPIFY_API_KEY / SHOPIFY_REDIRECT_URI not configured");
    res.redirect(installErrorRedirect("not_configured"));
    return;
  }

  // An intent, if this browser started the flow while signed in. Read, not
  // consumed: the merchant can still back out at Shopify's consent screen,
  // and burning it here would make the retry land in the anonymous path.
  const intentHandle = readIntentCookie(req);
  const intent = await readInstallIntent(intentHandle);

  // The state binds the VERIFIED shop, and the workspace only when an intent
  // established one. `tenantId` is required by the state's type, so the
  // anonymous case carries the empty string and `hasIntent` says which case
  // this is - the callback must never infer a tenant from a blank field.
  const { state } = mintOAuthState({
    tenantId: intent?.tenantId ?? "",
    provider: "shopify",
    shop,
    flow: intent?.flow,
    userId: intent?.userId,
    intentHandle: intent ? String(intentHandle) : undefined,
    hasIntent: Boolean(intent),
  });

  const url = buildShopifyAuthorizeUrl({
    shop,
    clientId: identity.clientId,
    scopes: SHOPIFY_OAUTH_SCOPES,
    redirectUri: identity.redirectUri,
    state,
  });
  if (!url) {
    console.error("[shopify install] authorize URL could not be built for a verified shop");
    res.redirect(installErrorRedirect("not_configured"));
    return;
  }

  // OAuth starts here, immediately. Nothing of GOTCHA has been rendered.
  res.redirect(302, url);
});

// ─── 3. Claiming a deferred install ──────────────────────────

/**
 * What is waiting for this browser to claim, if anything.
 *
 * Returns the shop name only. The pending record also holds an access token,
 * and no endpoint reachable from a browser returns it - not this one, not
 * the claim below.
 *
 * `peek`, not consume: the claim screen may be reloaded, and losing a
 * verified install to a refresh would mean reinstalling from Shopify.
 */
router.get(
  "/connectors/shopify/install/pending",
  authenticate,
  resolveTenant,
  requireOnboardingOrActiveTenant(),
  canConnectSystems,
  async (req: Request, res: Response) => {
    const summary = await peekPendingConnection(singleValue(req.query.handle));
    if (!summary) {
      res.status(404).json({ error: "pending_install_not_found" });
      return;
    }
    res.json({ data: { shopDomain: summary.shopDomain } });
  },
);

/**
 * Bind a verified-but-unclaimed installation to the caller's workspace.
 *
 * The workspace is `req.tenantId` - resolved by the same middleware every
 * other tenant write uses - and the permission is re-checked here rather than
 * inherited from whoever started the install. Those are the two things that
 * make this safe to expose: the claimant proves who they are and that they
 * may connect integrations, and the handle proves only that an install
 * happened.
 */
router.post(
  "/connectors/shopify/install/claim",
  authenticate,
  resolveTenant,
  requireActiveTenant(),
  canConnectSystems,
  async (req: Request, res: Response) => {
    const handle = typeof req.body?.handle === "string" ? req.body.handle : undefined;

    // Peek first so a conflict does NOT burn the one-shot claim: a merchant who
    // hits "already connected elsewhere" must still be able to disconnect there
    // and finish here, rather than having to reinstall from Shopify.
    const summary = await peekPendingConnection(handle);
    if (!summary) {
      res.status(404).json({ error: "pending_install_not_found" });
      return;
    }

    const pending = await consumePendingConnection(handle);
    if (!pending) {
      // Lost the race, or already claimed. Single-use, by construction.
      res.status(409).json({ error: "pending_install_already_used" });
      return;
    }

    const linked = await linkShopifyShopToTenant({
      tenantId: req.tenantId!,
      shopDomain: pending.shopDomain,
      credentials: pending.credentials as any,
      connectedBy: (req as any).user?.userId,
    });

    if (!linked.ok) {
      if (linked.reason === "shop_taken") {
        res.status(409).json({
          error: "shop_connected_to_another_workspace",
          detail:
            `${pending.shopDomain} is already connected to a different GOTCHA workspace. ` +
            "Disconnect it there first, then reconnect here.",
        });
        return;
      }
      res.status(500).json({ error: linked.reason });
      return;
    }

    // ── Billing ──
    //
    // An App Store install claimed into a workspace reaches billing here
    // instead of in the OAuth callback, because until this moment there was no
    // workspace to decide anything about. Same call, same rules: it runs after
    // the link and can only decide what to SHOW next.
    const outcome = await resolveShopifyBillingOutcome({
      tenantId: req.tenantId!,
      shopDomain: pending.shopDomain,
      accessToken: (pending.credentials as any)?.accessToken ?? "",
      apiVersion: shopifyApiVersion(),
      acquisitionSource: "app_store",
    }).catch(() => null);

    res.json({
      data: {
        shopDomain: pending.shopDomain,
        reconnected: linked.reconnected,
        flow: pending.flow ?? null,
        // The page navigates here when a plan is owed. Null for a grandfathered
        // merchant, for one already paying, and whenever billing is off.
        billingState: outcome?.state ?? null,
        planSelectionUrl: outcome?.requiresPlanSelection ? outcome.planSelectionUrl : null,
      },
    });
  },
);

/**
 * Abandon an intent without installing.
 *
 * Small, but it keeps a stale intent from silently capturing a LATER install
 * that the merchant meant for a different workspace.
 */
router.post(
  "/connectors/shopify/install/cancel",
  authenticate,
  resolveTenant,
  requireOnboardingOrActiveTenant(),
  async (req: Request, res: Response) => {
    await discardInstallIntent(readIntentCookie(req));
    res.clearCookie(INSTALL_INTENT_COOKIE, { path: "/" });
    res.json({ data: { cancelled: true } });
  },
);

export default router;
