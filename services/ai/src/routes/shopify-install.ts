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
  requireCoreForShopifyConnect,
  requireOnboardingOrActiveTenant,
  requirePermission,
  mintOAuthState,
  getShopifyAppIdentity,
  resolveShopifyInstallEntry,
  shopifyApiVersion,
  resolveAppPublicUrl,
  verifyAppEntryHmac,
  verifyAppEntryForShop,
  appForShop,
  buildShopifyAuthorizeUrl,
  singleValue,
  parseSessionCookie,
  readDurableSetting,
  writeDurableSetting,
  normalizeShopifyShopDomain,
  coreAllowsShopifyConnect,
  readPrivateAppsSettings,
} from "@chatcenter/shared";
import { isRedesignSystemsFlow, redesignSystemsPath } from "../services/redesign-return";
import {
  createInstallIntent,
  readInstallIntent,
  discardInstallIntent,
  peekPendingConnection,
  peekPendingAccessToken,
  consumePendingConnection,
  clearPendingInstallCookie,
  discardPendingConnection,
  PENDING_CONNECTION_TTL_SECONDS,
  INSTALL_INTENT_COOKIE,
  INSTALL_INTENT_TTL_SECONDS,
  PENDING_INSTALL_COOKIE,
} from "../services/shopify-install-intent.service";
import {
  SHOPIFY_OAUTH_SCOPES,
  linkShopifyShopToTenant,
  pendingStoreReplacement,
  findShopOwner,
  shopHeldElsewhere,
  currentStoreOf,
} from "../services/shopify-connection-link.service";
import { resolveShopifyBillingOutcome, CrossTenantShopError } from "../services/shopify-billing-bridge.service";
import { retireReplacedStore } from "../services/shopify-store-replace.service";
import { customAppBillingOutcome, markCustomAppInstalled } from "../services/shopify-custom-app-billing.service";
import { customAppForShop } from "@chatcenter/shared/src/lib/shopify-custom-app";

const router = Router();

const canConnectSystems = requirePermission(
  "integrations:connections:connect",
  "business-systems:connections:connect",
);

/** Recognised `flow` values - the same allow-list the OAuth callback uses. */
const KNOWN_FLOWS = new Set(["onboarding", "settings_business_systems", "redesign_studio", "onboarding_systems"]);
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
  // 2026-10-09: lands on the v2 studio. The v1 target
  // (/settings/business-systems?shopify_install_error=) never read the param,
  // so a refused install told the merchant nothing.
  const params = new URLSearchParams({ system: "shopify", error: reason });
  return `${base}/studio/capabilities?${params.toString()}`;
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
  // A store connects only after GOTCHA Core is paid (Omer, 2026-10-28): the
  // claim's own rule, refused as core_plan_required before any intent exists.
  requireCoreForShopifyConnect(),
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

    const flow = parseFlow(req.query.flow);
    const handle = await createInstallIntent({
      tenantId: req.tenantId!,
      userId: (req as any).user?.userId,
      flow,
    });
    // Which app this workspace's latest Shopify connect started from. Shopify
    // sends the merchant back from its plan page to ONE fixed URL per app, so
    // the flow cannot travel through it; the billing return reads this instead.
    // Best-effort: a failed write only means the old landing.
    await writeDurableSetting(
      req.tenantId!,
      SHOPIFY_RETURN_FLOW_KEY,
      isRedesignSystemsFlow(flow) ? flow : null,
    ).catch(() => undefined);

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

    // `mode` tells the UI which of two honest states this is: a live listing to
    // navigate to, or "installation begins on Shopify" to explain. It is never
    // an error, and there is never a shop-domain prompt.
    //
    // Sending a URL unconditionally is what put a 404 behind this button: an
    // unapproved listing is not publicly reachable, and a Limited-visibility
    // app never appears in App Store search even after approval.
    if (entry.mode === "listing") {
      res.json({ url: entry.url, mode: entry.mode });
      return;
    }

    // ── No live listing yet: still a working Connect (App Review 132211, 2026-11-22) ──
    //
    // A store this workspace held (CONNECTED, ERROR or uninstalled): Shopify's own authorize page for
    // THAT store, the same state the install entry mints, so the callback links it back here and the
    // claim says reconnected. Nothing is typed: the shop is the workspace's own, from its row.
    const known = await currentStoreOf(req.tenantId!).catch(() => null);
    const identity = getShopifyAppIdentity();
    // The store's own app: a per-merchant custom app when it has one (2026-11-22), else the official app.
    const knownApp = known ? await appForShop(known.shopDomain) : null;
    if (known && knownApp?.clientId && identity.redirectUri) {
      const { state } = mintOAuthState({
        tenantId: req.tenantId!,
        provider: "shopify",
        shop: known.shopDomain,
        flow,
        userId: (req as any).user?.userId,
        intentHandle: handle,
        hasIntent: true,
        ...(knownApp.kind === "custom" ? { appClientId: knownApp.clientId } : {}),
      });
      const url = buildShopifyAuthorizeUrl({ shop: known.shopDomain, clientId: knownApp.clientId, scopes: SHOPIFY_OAUTH_SCOPES, redirectUri: identity.redirectUri, state });
      if (url) {
        res.json({ url, mode: "reconnect" });
        return;
      }
    }
    // A workspace with no store yet: the app's install link from the Partner Dashboard, when one is set
    // (SHOPIFY_INSTALL_LINK_URL, an https Shopify URL). The merchant picks the store at Shopify.
    const link = shopifyInstallLink();
    if (link) {
      res.json({ url: link, mode: "install_link" });
      return;
    }
    res.json({ url: entry.url, mode: entry.mode });
  },
);

/** The Partner Dashboard install link, or null when unset or not an https Shopify URL. */
export function shopifyInstallLink(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = String(env.SHOPIFY_INSTALL_LINK_URL ?? "").trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    const shopifyHost = host === "admin.shopify.com" || host === "apps.shopify.com" || host.endsWith(".myshopify.com");
    return u.protocol === "https:" && shopifyHost ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Whether a Shopify connection can be STARTED from inside GOTCHA right now.
 *
 * Read-only on purpose. `/install/start` mints a server-side intent and sets a
 * cookie, so a screen cannot call it just to decide what to render - doing so
 * would create an install intent for every page view.
 *
 * The UI needs this BEFORE the button is pressed. Learning at click time that
 * installation is not available yet means the merchant presses a button that
 * then explains why it does nothing, which is a worse version of the refusal
 * that failed review 132211.
 */
router.get(
  "/connectors/shopify/install/availability",
  authenticate,
  resolveTenant,
  requireOnboardingOrActiveTenant(),
  canConnectSystems,
  async (req: Request, res: Response) => {
    const entry = resolveShopifyInstallEntry();
    // No live listing, the platform's private apps switched on, and no store here: Connect asks for a
    // store link (a per-merchant custom app, 2026-11-22). The request itself: POST .../custom-app/request.
    let mode: string = entry.mode;
    if (entry.mode !== "listing") {
      const [settings, current] = await Promise.all([
        readPrivateAppsSettings().catch(() => ({ enabled: false })),
        currentStoreOf(req.tenantId!).catch(() => null),
      ]);
      if (settings.enabled && current?.status !== "CONNECTED") mode = "custom_app_request";
    }
    res.json({
      data: {
        mode,
        url: entry.url,
        // Where an operator can point a merchant while the listing is not
        // public - during App Store review this is the install link from the
        // Shopify dashboard. Optional, and NEVER a substitute for the listing:
        // it is shown as help, not as the install path, and it is not a URL
        // this service constructs.
        helpUrl: process.env.SHOPIFY_INSTALL_HELP_URL?.trim() || null,
      },
    });
  },
);

/** Per-tenant durable setting: the app a Shopify connect last started from. */
export const SHOPIFY_RETURN_FLOW_KEY = "shopify.returnFlow";

/**
 * Where Shopify's plan page should send the merchant, decided by the server.
 *
 * Shopify returns the merchant from its hosted plan page to ONE redirect URL
 * per app (Partner Dashboard), with `plan_handle` and `shop` - so a v2 connect
 * and an old-app connect come back to the same place. Pointed at this route,
 * that place can tell them apart: the shop names its workspace, and the
 * workspace remembers which app its latest connect began in.
 *
 *   redesign flow -> /studio/capabilities?system=shopify&billing=verify&shop=<shop>
 *                    (the v2 screen POSTs /api/billing/shopify/complete with
 *                     its own session, exactly as the old page does)
 *   anything else -> /integrations/shopify/billing/complete?<the same query>,
 *                    byte for byte the page Shopify sends people to today.
 *
 * Public, like the redirect it replaces. It grants nothing and reads nothing
 * back to the caller: the query is not evidence of payment (the complete call
 * re-verifies with Shopify), and the only thing a stranger learns is which of
 * two pages a shop's workspace uses.
 */
router.get("/connectors/shopify/billing/return", async (req: Request, res: Response) => {
  let base = "";
  try { base = resolveAppPublicUrl(process.env); } catch { base = ""; }
  const rawQuery = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?") + 1) : "";
  const legacy = `${base}/integrations/shopify/billing/complete${rawQuery ? `?${rawQuery}` : ""}`;
  try {
    const shop = normalizeShopifyShopDomain(singleValue(req.query.shop) || "");
    const owner = shop ? await findShopOwner(shop) : null;
    const flow = owner ? await readDurableSetting(owner.tenantId, SHOPIFY_RETURN_FLOW_KEY) : null;
    if (shop && isRedesignSystemsFlow(flow)) {
      const p = new URLSearchParams({ system: "shopify", billing: "verify", shop });
      res.redirect(`${base}${redesignSystemsPath(flow)}?${p.toString()}`);
      return;
    }
  } catch (err: any) {
    console.warn("[shopify billing return] could not resolve the app, using the old page:", err?.message);
  }
  res.redirect(legacy);
});

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

  // Verified with the app that serves this shop: its per-merchant custom app when it has one
  // (2026-11-22), else the official app. A signature of an app we do not know is never accepted.
  const verified = await verifyAppEntryForShop(req.query as Record<string, unknown>);
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
  const app = verified.app;

  if (!app.clientId || !identity.redirectUri) {
    console.error("[shopify install] SHOPIFY_API_KEY / SHOPIFY_REDIRECT_URI not configured");
    res.redirect(installErrorRedirect("not_configured"));
    return;
  }

  // An intent, if this browser started the flow while signed in. Read, not
  // consumed: the merchant can still back out at Shopify's consent screen,
  // and burning it here would make the retry land in the anonymous path.
  const intentHandle = readIntentCookie(req);
  const intent = await readInstallIntent(intentHandle);

  // Opened from Shopify for a store a workspace already holds and that works (App Review 132211):
  // into the app, not another anonymous OAuth that parks a second approval and bounces to sign-in.
  // Shopify signed this request for this shop; who may see the workspace is still the sign-in's.
  // A store that needs authorizing again (ERROR, DISCONNECTED) still goes through OAuth.
  if (!intent) {
    const owner = await findShopOwner(shop).catch(() => null);
    if (owner && owner.status === "CONNECTED") {
      let base = "";
      try { base = resolveAppPublicUrl(process.env); } catch { base = ""; }
      res.redirect(302, `${base}/studio/capabilities?system=shopify`);
      return;
    }
  }

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
    // The app this install runs through: the callback must be signed by the same one.
    ...(app.kind === "custom" ? { appClientId: app.clientId } : {}),
  });

  const url = buildShopifyAuthorizeUrl({
    shop,
    clientId: app.clientId,
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
    // What the person can do with it, from any page (App Review 132211, 2026-11-22): attach it,
    // replace the store this workspace holds (CONNECTED: their explicit answer), or nothing until a
    // refusal is resolved. Asked here so the prompt never offers a claim the claim would refuse.
    const current = await currentStoreOf(req.tenantId!).catch(() => null);
    const sameStore = current?.shopDomain === summary.shopDomain;
    const core = (req.user as any)?.role === "SYSTEM_ADMIN" ? { allowed: true } : await coreAllowsShopifyConnect(req.tenantId!).catch(() => ({ allowed: true }));
    const elsewhere = shopHeldElsewhere(await findShopOwner(summary.shopDomain).catch(() => null), req.tenantId!);
    const blockedReason = !core.allowed ? "core_plan_required" : elsewhere ? "held_by_other_workspace" : null;
    const action = blockedReason ? "blocked" : current?.status === "CONNECTED" && !sameStore ? "replace" : "attach";
    res.json({
      data: {
        shopDomain: summary.shopDomain,
        // Lets the UI say "we found the store you just authorized" rather than
        // implying the merchant navigated here on purpose.
        recovered: !singleValue(req.query.handle),
        expiresAt: new Date(summary.createdAt + PENDING_CONNECTION_TTL_SECONDS * 1000).toISOString(),
        current: current && !sameStore ? current : null,
        action,
        ...(blockedReason ? { blockedReason } : {}),
      },
    });
  },
);

/**
 * "Not now" on the claim prompt (App Review 132211, 2026-11-22): the parked install is dropped and the
 * cookie cleared. Nothing at Shopify is touched: the store the merchant just authorized is never
 * uninstalled from here, and installing again from Shopify parks it again.
 */
router.post(
  "/connectors/shopify/install/pending/dismiss",
  authenticate,
  resolveTenant,
  requireOnboardingOrActiveTenant(),
  canConnectSystems,
  async (req: Request, res: Response) => {
    await discardPendingConnection(readPendingCookie(req));
    clearPendingInstallCookie(res);
    res.status(204).end();
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
  // Onboarding reaches the systems step, but a store connects only after
  // GOTCHA Core is paid (Omer, 2026-10-28): the claim's rule, refused as a
  // stable core_plan_required the screen can say in plain words.
  requireOnboardingOrActiveTenant(),
  requireCoreForShopifyConnect(),
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

    // ── Ownership, then billing, BEFORE the handle is spent ──
    //
    // Billing used to run after the link with its failure swallowed, so a
    // store billing refused (2026-10-29: held by a workspace that had
    // disconnected it) came back 200 with ai CONNECTED and no billing row -
    // "No store connected" on the billing screen. Now either both hold the
    // store or neither does, and a refusal leaves the handle unspent so the
    // merchant can resolve it and claim again without reinstalling.
    const taken = () =>
      res.status(409).json({
        error: "shop_connected_to_another_workspace",
        detail:
          `${summary.shopDomain} is already connected to a different GOTCHA workspace. ` +
          "Disconnect it there first, then reconnect here.",
        data: { shopDomain: summary.shopDomain, handle },
      });
    if (shopHeldElsewhere(await findShopOwner(summary.shopDomain), req.tenantId!)) {
      taken();
      return;
    }

    // ── The old store goes first (App Review 132211, 2026-11-22) ──
    //
    // Confirmed Replace of a CONNECTED store, or a DISCONNECTED one left behind: the old store is retired
    // completely (uninstalled at Shopify with its own token while connected, billing and entitlements,
    // the grandfather grant, tools, chat) BEFORE the new one is billed and attached, so the new store's
    // access comes only from its own Shopify Billing. A billing failure after this leaves the old store
    // retired and the approval unspent: the next claim is a plain attach.
    const before = await currentStoreOf(req.tenantId!).catch(() => null);
    if (before && before.shopDomain !== summary.shopDomain && (before.status === "DISCONNECTED" || allowReplace)) {
      await retireReplacedStore({ tenantId: req.tenantId!, shopDomain: before.shopDomain, connected: before.status === "CONNECTED" });
    }

    const accessToken = await peekPendingAccessToken(handle);
    // A store on a per-merchant custom app (2026-11-22): made for ONE workspace, and billed by GOTCHA
    // (no Shopify Billing for custom distribution), never authorized by the OAuth alone.
    const customApp = await customAppForShop(summary.shopDomain).catch(() => null);
    if (customApp && customApp.tenantId !== req.tenantId) {
      res.status(409).json({ error: "custom_app_for_another_workspace" });
      return;
    }
    let outcome: Awaited<ReturnType<typeof resolveShopifyBillingOutcome>> = null;
    try {
      outcome = customApp
        ? (await customAppBillingOutcome(req.tenantId!)) as any
        : accessToken
        ? await resolveShopifyBillingOutcome({
            tenantId: req.tenantId!,
            shopDomain: summary.shopDomain,
            accessToken,
            apiVersion: shopifyApiVersion(),
            acquisitionSource: "app_store",
          })
        : null;
    } catch (err: any) {
      if (err instanceof CrossTenantShopError) {
        taken();
        return;
      }
      console.warn(`[shopify-install] claim billing link failed: ${err?.message}`);
      outcome = null;
    }
    if (!outcome) {
      // Billing unreachable, or Shopify did not give us the store's id. Nothing
      // was written in ai; the same handle can be claimed again.
      res.status(503).json({
        error: "billing_link_failed",
        detail: "We could not finish connecting the store. Nothing was changed; try again in a moment.",
        data: { shopDomain: summary.shopDomain, handle },
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

    // The installation is now a connection, so the cookie must not survive to
    // offer it again on the next page load.
    clearPendingInstallCookie(res);
    if (customApp) await markCustomAppInstalled(req.tenantId!).catch(() => undefined);

    res.json({
      data: {
        shopDomain: pending.shopDomain,
        reconnected: linked.reconnected,
        flow: pending.flow ?? null,
        // The page navigates here when a plan is owed. Null for a grandfathered
        // merchant, for one already paying, and whenever billing is off.
        billingState: outcome.state ?? null,
        planSelectionUrl: outcome.requiresPlanSelection ? outcome.planSelectionUrl : null,
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
