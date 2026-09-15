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
  resolveShopifyInstallEntry,
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
  clearPendingInstallCookie,
  INSTALL_INTENT_COOKIE,
  INSTALL_INTENT_TTL_SECONDS,
  PENDING_INSTALL_COOKIE,
} from "../services/shopify-install-intent.service";
import {
  SHOPIFY_OAUTH_SCOPES,
  linkShopifyShopToTenant,
  pendingStoreReplacement,
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

/**
 * The pending-install handle this browser is carrying, if any.
 *
 * Same codec and same failure posture as `readIntentCookie`: a malformed
 * Cookie header means "no pending install", never a failed request.
 */
export function readPendingCookie(req: Request): string | null {
  try {
    return parseSessionCookie(req.headers?.cookie, PENDING_INSTALL_COOKIE);
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
    // ALWAYS resolves to a Shopify-owned page. There is no configuration this
    // route can refuse on any more.
    //
    // It used to answer 503 `shopify_install_not_available` whenever the App
    // Store listing slug was unset, and Shopify App Store review 132211 quoted
    // the resulting screen back to us under requirement 4.5.5: the submitted
    // test account could not demonstrate the feature, because the only in-app
    // route to connecting a store refused. A gap in OUR configuration had
    // become the merchant's error message.
    //
    // `resolveShopifyInstallEntry` degrades to App Store search instead. Still
    // no shop domain is typed anywhere - requirement 2.3.1 is about not asking
    // the merchant to name their store, and neither branch does.
    const entry = resolveShopifyInstallEntry();

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

    // `precise` tells the UI whether this is the app's own listing or App Store
    // search, so it can add one line of guidance in the second case rather than
    // dropping the merchant on a search page with no explanation.
    res.json({ url: entry.url, precise: entry.precise });
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
    // The URL handle FIRST, the cookie as the fallback.
    //
    // The cookie is what makes a Shopify-originated install survivable. The
    // handle used to live only in the redirect's query string, so the
    // signed-out login bounce destroyed it and the authorized store became
    // unreachable - the failure Shopify App Store review 132211 recorded.
    const handle = singleValue(req.query.handle) || readPendingCookie(req);
    const summary = await peekPendingConnection(handle);
    if (!summary) {
      // Nothing to find. Drop a cookie pointing at an expired or consumed
      // record so the Shopify screen stops offering to finish an installation
      // that no longer exists.
      clearPendingInstallCookie(res);
      res.status(404).json({ error: "pending_install_not_found" });
      return;
    }
    // The shop name only, and deliberately NOT the handle. The pending record
    // also holds an access token, and the handle is the key to it; putting it
    // back in a response body would place it where a script, a referrer header
    // or a URL could carry it. The claim reads the same cookie instead, so the
    // browser never needs to hold the value at all.
    res.json({
      data: {
        shopDomain: summary.shopDomain,
        // Lets the UI say "we found the store you just authorized" rather than
        // implying the merchant navigated here on purpose.
        recovered: !singleValue(req.query.handle),
      },
    });
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
    // Body first, cookie as the fallback - the same recovery the pending
    // lookup uses, so a claim works after an OIDC round trip that dropped the
    // URL. The handle proves only that THIS browser completed the Shopify
    // authorization; who may claim it is decided by `authenticate`,
    // `resolveTenant` and `canConnectSystems` above, and the shop comes from
    // the server-side record rather than from anything the browser sent.
    const handle =
      (typeof req.body?.handle === "string" ? req.body.handle : undefined) ||
      readPendingCookie(req) ||
      undefined;

    // Peek first so a conflict does NOT burn the one-shot claim: a merchant who
    // hits "already connected elsewhere" must still be able to disconnect there
    // and finish here, rather than having to reinstall from Shopify.
    const summary = await peekPendingConnection(handle);
    if (!summary) {
      res.status(404).json({ error: "pending_install_not_found" });
      return;
    }

    // Replacing a store this workspace already holds is the merchant's call.
    // Asked BEFORE the handle is consumed: the handle is single-use, and
    // spending it on a question the merchant has not answered yet would mean
    // reinstalling from Shopify just to say "yes, replace it".
    //
    // `replace` is read from the body of an authenticated request whose caller
    // already passed `canConnectSystems`. It decides nothing about which
    // workspace or which store - both of those come from the session and from
    // Shopify's signed install - only whether an overwrite the merchant was
    // shown may proceed.
    const allowReplace = req.body?.replace === true;
    const replacing = await pendingStoreReplacement(req.tenantId!, summary.shopDomain);
    if (replacing && !allowReplace) {
      res.status(409).json({
        error: "another_store_connected",
        detail:
          `This workspace is connected to ${replacing}. ` +
          `Connecting ${summary.shopDomain} will disconnect it.`,
        data: {
          currentShopDomain: replacing,
          incomingShopDomain: summary.shopDomain,
          // The handle is still unspent, so the merchant's answer can be
          // submitted straight back without another trip through Shopify.
          handle,
        },
      });
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
      allowReplace,
    });

    if (!linked.ok) {
      if (linked.reason === "another_store_connected") {
        // Should be unreachable - the pre-consume check below answers this
        // first, precisely so the single-use handle is not spent on a question.
        // Kept because `linkShopifyShopToTenant` is the authority and a caller
        // that forgets to ask must fail closed rather than overwrite a store.
        res.status(409).json({
          error: "another_store_connected",
          detail: `This workspace is connected to ${linked.currentShopDomain}.`,
        });
        return;
      }
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

    // The installation is now a connection, so the cookie must not survive to
    // offer it again on the next page load.
    clearPendingInstallCookie(res);

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
