/**
 * Unified connector admin - OAuth + API-key + config + meta selectors
 * for every adapter shipped in services/ai/src/services/connectors/.
 *
 *   GET  /connectors/:slug/oauth/init        - start OAuth (returns auth URL)
 *   GET  /connectors/:slug/oauth/callback    - finish OAuth (302 redirect)
 *   POST /connectors/:slug/connect           - API-key style connect
 *   POST /connectors/:slug/config            - patch the integration `config` JSON
 *   POST /connectors/:slug/disconnect        - flip status to DISCONNECTED
 *   GET  /connectors/:slug/status            - cheap status read
 *   GET  /connectors/:slug/meta/:resource    - meta selectors (airtable bases/tables)
 *
 * Concrete OAuth flows:
 *   - stripe   (Stripe Connect)
 *   - hubspot
 *   - shopify  (per-shop). INSTALLATION starts in routes/shopify-install.ts on
 *              a Shopify-owned surface; `oauth/init` here is REAUTHORIZATION
 *              only and reads the shop from the stored connection. It no
 *              longer accepts a `shop` query parameter - that was the typed
 *              `.myshopify.com` domain App Store review rejects, and an
 *              unauthenticated claim we then redirected to.
 * API-key style:
 *   - airtable (PAT)
 *   - postgres / mongodb / aws_rds (connection string)
 *   - any tenant-supplied API key
 *
 * Tokens are encrypted via @chatcenter/shared encryptCredentials.
 */

import { Router, type Request, type Response } from "express";
import * as crypto from "crypto";
import { findCatalog, upsertConnection } from "../services/connector-connection.service";
import {
  prisma,
  authenticate,
  resolveTenant,
  requireActiveTenant,
  requireOnboardingOrActiveTenant,
  mintOAuthState,
  consumeOAuthState,
  requirePermission,
  encryptCredentials,
  getOAuthStateSecret,
  resolveAppPublicUrl,
  getShopifyAppIdentity,
  normalizeShopifyShopDomain,
  verifyOAuthCallbackHmac,
  buildShopifyAuthorizeUrl,
  singleValue,
} from "@chatcenter/shared";
import { airtableListBases, airtableListTables, airtableListFields, airtableCreateField } from "../services/connectors/airtable.adapter";
import { mondayListBoards } from "../services/connectors/monday.adapter";
import { loadConnection, refreshCapabilityState } from "../services/connectors/integration-framework";
import { reconcileAgentToolPermissions } from "../services/tool-permission-reconcile.service";
import {
  SHOPIFY_OAUTH_SCOPES,
  linkShopifyShopToTenant,
  exchangeShopifyCode,
} from "../services/shopify-connection-link.service";
import {
  createPendingConnection,
  consumeInstallIntent,
  INSTALL_INTENT_COOKIE,
} from "../services/shopify-install-intent.service";
import { resolveShopifyBillingOutcome } from "../services/shopify-billing-bridge.service";
import { shopifyApiVersion } from "@chatcenter/shared";

const router = Router();
// OAuth `state` signing only - not user auth. See getOAuthStateSecret().
const OAUTH_STATE_SECRET = getOAuthStateSecret();

// ─── Authorization ──────────────────────────────────────────
// Permission-based (Active Membership), never Role==ADMIN. These routes serve
// BOTH the AI Studio marketplace (integrations:*) and Settings → Business
// Systems (business-systems:*), so each gate accepts either domain's key
// (requirePermission = OR semantics). Admin/Owner built-in roles hold all of
// these; tenants can delegate narrower slices per membership.
const canReadSystems = requirePermission("integrations:connections:read", "business-systems:connections:read");
const canConnectSystems = requirePermission("integrations:connections:connect", "business-systems:connections:connect");
const canManageSystems = requirePermission("integrations:connections:disconnect", "business-systems:connections:manage");

// ─── Helpers ────────────────────────────────────────────────

// `findCatalog` and `upsertConnection` moved to
// services/connector-connection.service.ts so the Shopify deferred-claim
// path can create an identical connection. Imported above; behaviour
// unchanged.

function dashboardRedirect(slug: string, query: Record<string, string> = {}) {
  const params = new URLSearchParams({ status: "connected", ...query });
  const path = `/ai-studio/marketplace/${slug}?${params.toString()}`;
  return process.env.DASHBOARD_URL ? `${process.env.DASHBOARD_URL}${path}` : path;
}

// Allow-list of recognised OAuth `flow` values. The flow is what the SERVER
// uses to decide where to land after the round-trip - it is NEVER a
// browser-supplied return URL, so an attacker cannot redirect the callback to
// an arbitrary destination. Unknown values collapse to `undefined` (the
// default marketplace landing).
const KNOWN_FLOWS = new Set(["onboarding", "settings_business_systems"]);
function parseFlow(raw: unknown): string | undefined {
  return typeof raw === "string" && KNOWN_FLOWS.has(raw) ? raw : undefined;
}

// Where to land after an OAuth round-trip. The destination is chosen from the
// SIGNED state's `flow`, mapped to a FIXED internal path here (never a URL from
// the browser):
//   • onboarding                → /setup (boot logic finishes activation)
//   • settings_business_systems → /settings/business-systems (Source-of-Truth
//     home - so a connect started in Settings returns to Settings, not the
//     AI Studio marketplace)
//   • otherwise                 → the provider's marketplace page
function postOAuthRedirect(slug: string, flow: string | undefined, query: Record<string, string> = {}) {
  const base = resolveAppPublicUrl(process.env);
  if (flow === "onboarding") {
    const params = new URLSearchParams({ connected: slug, ...query });
    return `${base}/setup?${params.toString()}`;
  }
  if (flow === "settings_business_systems") {
    const params = new URLSearchParams({ connected: slug, ...query });
    return `${base}/settings/business-systems?${params.toString()}`;
  }
  return dashboardRedirect(slug, query);
}

// base64url encode (no padding) - used for OAuth2 PKCE (Airtable).
function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ─── Status / disconnect / config (universal) ─────────────────

router.get(
  "/connectors/:slug/status",
  authenticate, resolveTenant, requireActiveTenant(), canReadSystems,
  async (req: Request, res: Response) => {
    const cat = await findCatalog(req.params.slug);
    if (!cat) { res.status(404).json({ error: "unknown_provider" }); return; }
    const ti = await (prisma as any).tenantIntegration.findUnique({
      where: { tenantId_integrationId: { tenantId: req.tenantId, integrationId: cat.id } },
      select: { status: true, connectedAt: true, lastTestedAt: true, lastError: true, config: true },
    });
    res.json({ data: ti || { status: "DISCONNECTED" } });
  },
);

router.post(
  "/connectors/:slug/disconnect",
  authenticate, resolveTenant, requireActiveTenant(), canManageSystems,
  async (req: Request, res: Response) => {
    const cat = await findCatalog(req.params.slug);
    if (!cat) { res.status(404).json({ error: "unknown_provider" }); return; }
    await (prisma as any).tenantIntegration.updateMany({
      where: { tenantId: req.tenantId, integrationId: cat.id },
      data: { status: "DISCONNECTED" },
    });
    res.json({ ok: true });
  },
);

router.post(
  "/connectors/:slug/config",
  authenticate, resolveTenant, requireActiveTenant(), canManageSystems,
  async (req: Request, res: Response) => {
    const cat = await findCatalog(req.params.slug);
    if (!cat) { res.status(404).json({ error: "unknown_provider" }); return; }
    const ti = await (prisma as any).tenantIntegration.findUnique({
      where: { tenantId_integrationId: { tenantId: req.tenantId, integrationId: cat.id } },
    });
    if (!ti) { res.status(404).json({ error: "not_connected" }); return; }
    const merged = { ...(ti.config || {}), ...(req.body?.config || {}) };
    await (prisma as any).tenantIntegration.update({ where: { id: ti.id }, data: { config: merged } });
    res.json({ ok: true, config: merged });
  },
);

// ─── API-key style connect (airtable, postgres, mongodb, custom api-key) ──

// Verify the pasted credential actually works BEFORE storing it as CONNECTED.
// Without this, any garbage token connected "successfully" and only failed
// later at first sync/tool call - which reads as "the integration is broken".
async function validateApiKeyCredentials(
  slug: string,
  credentials: Record<string, string>,
): Promise<{ ok: boolean; error?: string }> {
  const withTimeout = (ms: number) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    return { signal: ctl.signal, done: () => clearTimeout(t) };
  };
  try {
    if (slug === "fireberry") {
      const tokenid = credentials.tokenid || credentials.apiKey || credentials.token;
      if (!tokenid) return { ok: false, error: "missing_tokenid" };
      const t = withTimeout(8000);
      const resp = await fetch("https://api.fireberry.com/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json", tokenid },
        body: JSON.stringify({ objecttype: 1, page_size: 1, fields: "accountid" }),
        signal: t.signal,
      }).finally(t.done);
      return resp.ok
        ? { ok: true }
        : { ok: false, error: resp.status === 401 || resp.status === 403 ? "invalid_token" : `fireberry_http_${resp.status}` };
    }
    if (slug === "airtable") {
      const pat = credentials.apiKey || credentials.token || credentials.pat;
      if (!pat) return { ok: false, error: "missing_api_key" };
      const t = withTimeout(8000);
      const resp = await fetch("https://api.airtable.com/v0/meta/whoami", {
        headers: { Authorization: `Bearer ${pat}` },
        signal: t.signal,
      }).finally(t.done);
      return resp.ok
        ? { ok: true }
        : { ok: false, error: resp.status === 401 || resp.status === 403 ? "invalid_token" : `airtable_http_${resp.status}` };
    }
    return { ok: true }; // no validator for this provider - keep prior behavior
  } catch (e: any) {
    // Network failure/timeouts on OUR side must not hard-block connecting.
    console.warn(`[connectors] ${slug} credential validation unreachable: ${e?.message}`);
    return { ok: true };
  }
}

router.post(
  "/connectors/:slug/connect",
  // Onboarding connects the CRM (Fireberry / Airtable-PAT) BEFORE the tenant is
  // ACTIVE - connecting is what flips it. requireActiveTenant() 403'd here, which
  // is exactly why "connect Fireberry" looked broken. Match the OAuth routes.
  authenticate, resolveTenant, requireOnboardingOrActiveTenant(), canConnectSystems,
  async (req: Request, res: Response) => {
    const cat = await findCatalog(req.params.slug);
    if (!cat) { res.status(404).json({ error: "unknown_provider" }); return; }
    const credentials = req.body?.credentials || {};
    const config = req.body?.config || {};
    if (!credentials || Object.keys(credentials).length === 0) {
      res.status(400).json({ error: "credentials_required" });
      return;
    }
    const check = await validateApiKeyCredentials(String(req.params.slug), credentials);
    if (!check.ok) {
      res.status(400).json({ error: "invalid_credentials", detail: check.error });
      return;
    }
    await upsertConnection({
      tenantId: req.tenantId!,
      catalogId: cat.id,
      status: "CONNECTED",
      credentialsBlob: encryptCredentials(credentials),
      config,
      connectedBy: (req as any).userId,
    });
    res.json({ ok: true });
  },
);

// ─── Stripe OAuth ────────────────────────────────────────────

router.get(
  "/connectors/stripe/oauth/init",
  // Onboarding-reachable like every other connector: during onboarding the
  // tenant is PENDING_ONBOARDING, and requireActiveTenant() 403s there.
  authenticate, resolveTenant, requireOnboardingOrActiveTenant(), canConnectSystems,
  (req: Request, res: Response) => {
    const clientId = process.env.STRIPE_CLIENT_ID;
    const redirect = process.env.STRIPE_REDIRECT_URI;
    if (!clientId || !redirect) { res.status(500).json({ error: "stripe_oauth_not_configured" }); return; }
    const { state } = mintOAuthState({ tenantId: req.tenantId!, provider: "stripe", userId: (req as any).user?.userId });
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      scope: "read_write",
      redirect_uri: redirect,
      state,
    });
    res.json({ url: `https://connect.stripe.com/oauth/authorize?${params.toString()}` });
  },
);

router.get("/connectors/stripe/oauth/callback", async (req: Request, res: Response) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) { res.status(400).send("missing_code_or_state"); return; }
    const consumed = await consumeOAuthState<any>(state as string, "stripe");
    if (!consumed.ok) {
      // Replay and forgery look identical to the caller; only our logs distinguish them.
      console.warn(`[stripe oauth] state rejected: ${consumed.reason}`);
      res.status(400).send(consumed.reason === "replayed" ? "state_already_used" : "bad_state");
      return;
    }
    const payload = consumed.claims;

    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) { res.status(500).send("stripe_secret_not_configured"); return; }

    const tokenRes = await fetch("https://connect.stripe.com/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${secret}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: String(code),
      }).toString(),
    });
    if (!tokenRes.ok) { res.status(400).send("token_exchange_failed"); return; }
    const j: any = await tokenRes.json();
    const cat = await findCatalog("stripe");
    if (!cat) { res.status(500).send("stripe_catalog_missing"); return; }
    await upsertConnection({
      tenantId: payload.tenantId,
      catalogId: cat.id,
      status: "CONNECTED",
      credentialsBlob: encryptCredentials({
        accessToken: j.access_token,
        refreshToken: j.refresh_token,
        scope: j.scope,
        stripeUserId: j.stripe_user_id,
        livemode: j.livemode,
      }),
    });
    res.redirect(dashboardRedirect("stripe"));
  } catch (err: any) {
    res.status(500).send(`stripe_callback_error:${err?.message || ""}`);
  }
});

// ─── HubSpot OAuth ───────────────────────────────────────────

router.get(
  "/connectors/hubspot/oauth/init",
  authenticate, resolveTenant, requireOnboardingOrActiveTenant(), canConnectSystems,
  (req: Request, res: Response) => {
    const clientId = process.env.HUBSPOT_CLIENT_ID;
    const redirect = process.env.HUBSPOT_REDIRECT_URI;
    if (!clientId || !redirect) { res.status(500).json({ error: "hubspot_oauth_not_configured" }); return; }
    const flow = parseFlow(req.query.flow);
    const { state } = mintOAuthState({ tenantId: req.tenantId!, provider: "hubspot", flow, userId: (req as any).user?.userId });
    // HubSpot enforces an EXACT scope contract between the install URL and the
    // app's configured scopes (HubSpot dashboard → Auth → Scopes):
    //   1. Every scope the app marks "Required" must appear in the install URL,
    //      else: "provided scopes are missing [...]".
    //   2. Every scope in the install URL must be configured on the app (required
    //      OR optional), else: "mismatch between the scopes in the install URL
    //      and the app's configured scopes".
    // Because that list lives in the HubSpot dashboard (not here), it is
    // env-overridable so it can be aligned WITHOUT a rebuild. Set HUBSPOT_SCOPES
    // (space- or comma-separated) to the app's exact required scopes; optionally
    // set HUBSPOT_OPTIONAL_SCOPES for app-optional ones. `oauth` is always added.
    // Default = every object the HubSpot adapter actually uses: contacts,
    // companies, deals, and leads (the adapter has create_lead/update_lead/
    // get_lead/search_leads via /crm/v3/objects/leads). Leads scopes 403 silently
    // for tenants without the Leads object (Pro/Starter) - harmless.
    // Appointments read/write are included because the CURRENT HubSpot app marks
    // them "Required" in its dashboard - HubSpot then rejects any install URL that
    // omits a Required scope ("provided scopes are missing [crm.objects.appointments...]").
    // The adapter makes no appointments calls; the scope is requested only to
    // satisfy HubSpot's exact-match contract so the connection completes. (If the
    // dashboard later drops them as Required, remove them here or override via
    // HUBSPOT_SCOPES.)
    const DEFAULT_SCOPES = [
      "crm.objects.contacts.read",
      "crm.objects.contacts.write",
      "crm.objects.companies.read",
      "crm.objects.companies.write",
      "crm.objects.deals.read",
      "crm.objects.deals.write",
      "crm.objects.leads.read",
      "crm.objects.leads.write",
      "crm.objects.appointments.read",
      "crm.objects.appointments.write",
    ];
    const parseScopes = (raw: string | undefined): string[] =>
      (raw ?? "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    const required = process.env.HUBSPOT_SCOPES ? parseScopes(process.env.HUBSPOT_SCOPES) : DEFAULT_SCOPES;
    const scope = Array.from(new Set([...required, "oauth"])).join(" ");
    const optionalScopes = parseScopes(process.env.HUBSPOT_OPTIONAL_SCOPES);
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirect,
      scope,
      state,
    });
    if (optionalScopes.length) params.set("optional_scope", optionalScopes.join(" "));
    res.json({ url: `https://app.hubspot.com/oauth/authorize?${params.toString()}` });
  },
);

router.get("/connectors/hubspot/oauth/callback", async (req: Request, res: Response) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) { res.status(400).send("missing_code_or_state"); return; }
    const consumed = await consumeOAuthState<any>(state as string, "hubspot");
    if (!consumed.ok) {
      // Replay and forgery look identical to the caller; only our logs distinguish them.
      console.warn(`[hubspot oauth] state rejected: ${consumed.reason}`);
      res.status(400).send(consumed.reason === "replayed" ? "state_already_used" : "bad_state");
      return;
    }
    const payload = consumed.claims;

    const clientId = process.env.HUBSPOT_CLIENT_ID!;
    const clientSecret = process.env.HUBSPOT_CLIENT_SECRET!;
    const redirect = process.env.HUBSPOT_REDIRECT_URI!;

    const tokenRes = await fetch("https://api.hubapi.com/oauth/v1/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirect,
        code: String(code),
      }).toString(),
    });
    if (!tokenRes.ok) { res.status(400).send("token_exchange_failed"); return; }
    const j: any = await tokenRes.json();
    const cat = await findCatalog("hubspot");
    if (!cat) { res.status(500).send("hubspot_catalog_missing"); return; }
    await upsertConnection({
      tenantId: payload.tenantId,
      catalogId: cat.id,
      status: "CONNECTED",
      credentialsBlob: encryptCredentials({
        accessToken: j.access_token,
        refreshToken: j.refresh_token,
        expiresAt: new Date(Date.now() + Number(j.expires_in || 1800) * 1000).toISOString(),
      }),
    });
    res.redirect(postOAuthRedirect("hubspot", payload.flow));
  } catch (err: any) {
    res.status(500).send(`hubspot_callback_error:${err?.message || ""}`);
  }
});

// ─── Shopify OAuth ───────────────────────────────────────────
//
// Installation NO LONGER STARTS HERE. The merchant-facing entry point is
// `/connectors/shopify/install/start` (routes/shopify-install.ts), which sends
// them to a Shopify-owned page; Shopify then calls our public install handler
// with a signed request and OAuth begins there.
//
// What remains here is the two halves that must stay:
//
//   init      REAUTHORIZATION only. A workspace that already holds a Shopify
//             connection re-granting scopes, or replacing a revoked token.
//             The shop is read from the STORED connection, never from the
//             request - which is what lets this route keep existing without
//             reintroducing the typed-domain hole it used to be.
//
//   callback  The single OAuth callback for every path. Shopify posts back
//             here for a fresh install, a reinstall and a reauthorization
//             alike, so the branching on "did we know the workspace?" lives
//             here rather than in three places.

router.get(
  "/connectors/shopify/oauth/init",
  authenticate, resolveTenant, requireOnboardingOrActiveTenant(), canConnectSystems,
  async (req: Request, res: Response) => {
    const identity = getShopifyAppIdentity();
    if (!identity.clientId || !identity.redirectUri) {
      res.status(500).json({ error: "shopify_oauth_not_configured" });
      return;
    }

    // The shop comes from what this tenant already connected. A tenant with no
    // Shopify connection has nothing to reauthorize, and is told to install
    // rather than being offered a box to type a domain into - the whole point
    // of this change.
    const conn = await loadConnection({ tenantId: req.tenantId!, slug: "shopify" }).catch(() => null);
    const shop = normalizeShopifyShopDomain((conn?.config as any)?.shopDomain);
    if (!shop) {
      res.status(409).json({
        error: "shopify_not_connected",
        detail: "Start a new installation from Shopify - use Connect Shopify.",
      });
      return;
    }

    const { state } = mintOAuthState({
      tenantId: req.tenantId!,
      provider: "shopify",
      shop,
      flow: parseFlow(req.query.flow),
      userId: (req as any).user?.userId,
      hasIntent: true,
    });

    const url = buildShopifyAuthorizeUrl({
      shop,
      clientId: identity.clientId,
      scopes: SHOPIFY_OAUTH_SCOPES,
      redirectUri: identity.redirectUri,
      state,
    });
    if (!url) { res.status(500).json({ error: "shopify_oauth_not_configured" }); return; }
    res.json({ url });
  },
);

/**
 * The OAuth callback. Public by necessity - Shopify calls it, not a browser
 * we authenticated.
 *
 * Four checks, in this order, before anything is written:
 *
 *   1. HMAC over the callback query. This was MISSING before: the callback
 *      trusted `shop` and `code` from an unsigned request, so anything that
 *      could guess a live `state` could have driven a token exchange against
 *      a host of its choosing.
 *   2. Single-use `state`, consumed exactly once (Redis SET NX, fail-closed).
 *   3. The shop Shopify returned must equal the shop bound INTO the state at
 *      install time. A mismatch means the state was moved to another store.
 *   4. Only then, the code exchange.
 *
 * After that the workspace question: an intent means we already knew it, no
 * intent means the install started on Shopify and the merchant must sign in
 * before anything is bound to a tenant.
 */
router.get("/connectors/shopify/oauth/callback", async (req: Request, res: Response) => {
  try {
    const identity = getShopifyAppIdentity();

    // 1. Signature. A forged callback dies here, before `state` is even read.
    const signed = verifyOAuthCallbackHmac(req.query as Record<string, unknown>, identity.clientSecret);
    if (!signed.ok) {
      console.warn(`[shopify oauth] callback rejected: ${signed.reason}`);
      res.status(400).send("invalid_request");
      return;
    }
    const shop = signed.shop;

    const code = singleValue(req.query.code);
    const rawState = singleValue(req.query.state);
    if (!code || !rawState) { res.status(400).send("invalid_request"); return; }

    // 2. Single use. Expired, reused and forged are distinguished in the log
    //    and identical to the caller.
    const consumed = await consumeOAuthState<any>(rawState, "shopify");
    if (!consumed.ok) {
      console.warn(`[shopify oauth] state rejected: ${consumed.reason}`);
      res.status(400).send(consumed.reason === "replayed" ? "state_already_used" : "bad_state");
      return;
    }
    const payload = consumed.claims;

    // 3. The state was minted for ONE store.
    if (normalizeShopifyShopDomain(payload.shop) !== shop) {
      console.warn("[shopify oauth] callback shop does not match the shop bound into state");
      res.status(400).send("bad_state");
      return;
    }

    // 4. Exchange. The token never leaves this function except into
    //    encryptCredentials - not into a log line, not into a redirect.
    const creds = await exchangeShopifyCode({
      shop,
      code,
      clientId: identity.clientId,
      clientSecret: identity.clientSecret,
    });
    if (!creds) { res.status(400).send("token_exchange_failed"); return; }

    // ── Workspace ──
    //
    // `hasIntent` is the ONLY thing that authorizes a direct link, and it was
    // written into the state by an authenticated route. A blank tenantId with
    // hasIntent set would be a bug, so it is treated as no intent rather than
    // as "some tenant".
    const tenantId = payload.hasIntent && typeof payload.tenantId === "string" && payload.tenantId
      ? payload.tenantId
      : null;

    if (!tenantId) {
      // Install began on Shopify. Park the verified installation and ask the
      // merchant to sign in; the workspace is decided by THAT session.
      const handle = await createPendingConnection({
        shopDomain: shop,
        credentials: creds,
        scope: creds.scope,
        flow: payload.flow,
      });
      // Same fail-soft as the install entry point: a missing FRONTEND_URL must
      // not turn a SUCCESSFUL authorization into a 500 that loses the token.
      let base = "";
      try { base = resolveAppPublicUrl(process.env); } catch { base = ""; }
      res.redirect(`${base}/settings/business-systems/shopify/finish?handle=${encodeURIComponent(handle)}`);
      return;
    }

    const linked = await linkShopifyShopToTenant({
      tenantId,
      shopDomain: shop,
      credentials: creds,
      connectedBy: typeof payload.userId === "string" ? payload.userId : undefined,
    });

    // The intent has served its purpose either way - a failed link must not
    // leave a handle that a later, unrelated install could pick up.
    if (typeof payload.intentHandle === "string") {
      await consumeInstallIntent(payload.intentHandle);
    }
    res.clearCookie(INSTALL_INTENT_COOKIE, { path: "/" });

    if (!linked.ok) {
      if (linked.reason === "shop_taken") {
        // Never silently moved. The merchant is told, and resolves it by
        // disconnecting in the workspace that holds it.
        let base = "";
        try { base = resolveAppPublicUrl(process.env); } catch { base = ""; }
        res.redirect(`${base}/settings/business-systems?shopify_install_error=shop_connected_elsewhere`);
        return;
      }
      res.status(500).send(`shopify_link_failed:${linked.reason}`);
      return;
    }

    // ── Billing ──
    //
    // Runs only AFTER the store is linked, and cannot undo that. The three
    // acquisition paths converge here: the confirmed model says billing does
    // not depend on where the merchant came from, so `acquisitionSource` is
    // recorded for later analysis and reads on nothing.
    //
    // A merchant who owes Shopify a plan is sent to Shopify's own hosted plan
    // page. One who is grandfathered, already paying, or on a deployment with
    // billing switched off goes straight to the connected screen exactly as
    // before.
    const outcome = await resolveShopifyBillingOutcome({
      tenantId,
      shopDomain: shop,
      accessToken: creds.accessToken,
      apiVersion: shopifyApiVersion(),
      acquisitionSource: payload.hasIntent ? "in_app_connect" : "app_store",
    }).catch(() => null);

    if (outcome?.requiresPlanSelection && outcome.planSelectionUrl) {
      res.redirect(outcome.planSelectionUrl);
      return;
    }

    res.redirect(postOAuthRedirect("shopify", payload.flow));
  } catch (err: any) {
    // The message may carry request detail; the token cannot reach it (the
    // exchange returns null rather than throwing with a body).
    console.error("[shopify oauth] callback failed:", err?.message);
    res.status(500).send("shopify_callback_error");
  }
});

// ─── Airtable meta selectors ─────────────────────────────────

router.get(
  "/connectors/airtable/meta/bases",
  authenticate, resolveTenant, requireActiveTenant(), canConnectSystems,
  async (req: Request, res: Response) => {
    const pat = String(req.query.pat || "");
    if (!pat) { res.status(400).json({ error: "pat_required" }); return; }
    try {
      const bases = await airtableListBases(pat);
      res.json({ data: bases });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || "airtable_meta_failed" });
    }
  },
);

router.get(
  "/connectors/airtable/meta/tables/:baseId",
  authenticate, resolveTenant, requireActiveTenant(), canConnectSystems,
  async (req: Request, res: Response) => {
    const pat = String(req.query.pat || "");
    if (!pat) { res.status(400).json({ error: "pat_required" }); return; }
    try {
      const tables = await airtableListTables(pat, String(req.params.baseId));
      res.json({ data: tables });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || "airtable_meta_failed" });
    }
  },
);

// ─── Airtable OAuth (OAuth2 + PKCE) ──────────────────────────
//
// Airtable mandates PKCE (S256). Our other OAuth flows are plain auth-code;
// here we generate a code_verifier, send its S256 challenge on init, and carry
// the verifier inside the signed, short-lived state JWT so the callback can
// complete the token exchange. Confidential client → also HTTP Basic with the
// client secret. Reachable during onboarding (requireOnboardingOrActiveTenant).

router.get(
  "/connectors/airtable/oauth/init",
  authenticate, resolveTenant, requireOnboardingOrActiveTenant(), canConnectSystems,
  (req: Request, res: Response) => {
    const clientId = process.env.AIRTABLE_CLIENT_ID;
    const redirect = process.env.AIRTABLE_REDIRECT_URI;
    if (!clientId || !redirect) { res.status(500).json({ error: "airtable_oauth_not_configured" }); return; }
    const flow = parseFlow(req.query.flow);
    const verifier = base64url(crypto.randomBytes(48));
    const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
    const { state } = mintOAuthState({ tenantId: req.tenantId!, provider: "airtable", flow, v: verifier, userId: (req as any).user?.userId });
    const scope = "data.records:read data.records:write schema.bases:read schema.bases:write";
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirect,
      response_type: "code",
      scope,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    res.json({ url: `https://airtable.com/oauth2/v1/authorize?${params.toString()}` });
  },
);

router.get("/connectors/airtable/oauth/callback", async (req: Request, res: Response) => {
  try {
    const { code, state, error } = req.query;
    if (error) { res.status(400).send(`airtable_oauth_error:${String(error)}`); return; }
    if (!code || !state) { res.status(400).send("missing_code_or_state"); return; }
    const consumed = await consumeOAuthState<any>(state as string, "airtable");
    if (!consumed.ok) {
      // Replay and forgery look identical to the caller; only our logs distinguish them.
      console.warn(`[airtable oauth] state rejected: ${consumed.reason}`);
      res.status(400).send(consumed.reason === "replayed" ? "state_already_used" : "bad_state");
      return;
    }
    const payload = consumed.claims;
    const clientId = process.env.AIRTABLE_CLIENT_ID!;
    const clientSecret = process.env.AIRTABLE_CLIENT_SECRET || "";
    const redirect = process.env.AIRTABLE_REDIRECT_URI!;
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: String(code),
      redirect_uri: redirect,
      client_id: clientId,
      code_verifier: String(payload.v || ""),
    });
    const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
    if (clientSecret) headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
    const tokenRes = await fetch("https://airtable.com/oauth2/v1/token", { method: "POST", headers, body: body.toString() });
    if (!tokenRes.ok) {
      const t = await tokenRes.text().catch(() => "");
      res.status(400).send(`token_exchange_failed:${t.slice(0, 200)}`);
      return;
    }
    const j: any = await tokenRes.json();
    const cat = await findCatalog("airtable");
    if (!cat) { res.status(500).send("airtable_catalog_missing"); return; }
    await upsertConnection({
      tenantId: payload.tenantId,
      catalogId: cat.id,
      status: "CONNECTED",
      credentialsBlob: encryptCredentials({
        accessToken: j.access_token,
        refreshToken: j.refresh_token,
        expiresAt: j.expires_in ? new Date(Date.now() + Number(j.expires_in) * 1000).toISOString() : undefined,
        scope: j.scope,
      }),
    });
    // Onboarding still needs the base/table/column mapping after OAuth, so the
    // /setup page detects "connected airtable without fieldMap" and shows the
    // mapping wizard before completing.
    res.redirect(postOAuthRedirect("airtable", payload.flow));
  } catch (err: any) {
    res.status(500).send(`airtable_callback_error:${err?.message || ""}`);
  }
});

// ─── Airtable: CRM source mapping (post-OAuth) ───────────────
//
// After OAuth we still need to know which base/table is "contacts" and which
// columns map to canonical fields. These power the mapping wizard and run
// during onboarding. They read the stored OAuth token (no PAT query param).

async function airtableToken(tenantId: string): Promise<string | null> {
  const conn = await loadConnection({ tenantId, slug: "airtable" });
  return (conn?.credentials?.accessToken as string) || (conn?.credentials?.apiKey as string) || null;
}

router.get(
  "/connectors/airtable/oauth/bases",
  authenticate, resolveTenant, requireOnboardingOrActiveTenant(), canConnectSystems,
  async (req: Request, res: Response) => {
    const token = await airtableToken(req.tenantId!);
    if (!token) { res.status(400).json({ error: "not_connected" }); return; }
    try { res.json({ data: await airtableListBases(token) }); }
    catch (e: any) { res.status(400).json({ error: e?.message || "airtable_meta_failed" }); }
  },
);

router.get(
  "/connectors/airtable/oauth/tables",
  authenticate, resolveTenant, requireOnboardingOrActiveTenant(), canConnectSystems,
  async (req: Request, res: Response) => {
    const token = await airtableToken(req.tenantId!);
    const baseId = String(req.query.baseId || "");
    if (!token) { res.status(400).json({ error: "not_connected" }); return; }
    if (!baseId) { res.status(400).json({ error: "baseId_required" }); return; }
    try { res.json({ data: await airtableListTables(token, baseId) }); }
    catch (e: any) { res.status(400).json({ error: e?.message || "airtable_meta_failed" }); }
  },
);

router.get(
  "/connectors/airtable/oauth/fields",
  authenticate, resolveTenant, requireOnboardingOrActiveTenant(), canConnectSystems,
  async (req: Request, res: Response) => {
    const token = await airtableToken(req.tenantId!);
    const baseId = String(req.query.baseId || "");
    const tableId = String(req.query.tableId || "");
    if (!token) { res.status(400).json({ error: "not_connected" }); return; }
    if (!baseId || !tableId) { res.status(400).json({ error: "baseId_and_tableId_required" }); return; }
    try { res.json({ data: await airtableListFields(token, baseId, tableId) }); }
    catch (e: any) { res.status(400).json({ error: e?.message || "airtable_meta_failed" }); }
  },
);

// Read the mapping currently on the connection config - powers the
// post-onboarding "refresh fields / edit mapping" card. The onboarding wizard
// never needed this (it writes a fresh mapping), which is why editing the
// mapping after onboarding used to be impossible without reconnecting.
router.get(
  "/connectors/airtable/mapping",
  authenticate, resolveTenant, requireOnboardingOrActiveTenant(), canConnectSystems,
  async (req: Request, res: Response) => {
    const cat = await findCatalog("airtable");
    if (!cat) { res.status(404).json({ error: "unknown_provider" }); return; }
    const ti = await (prisma as any).tenantIntegration.findUnique({
      where: { tenantId_integrationId: { tenantId: req.tenantId, integrationId: cat.id } },
    });
    if (!ti) { res.status(400).json({ error: "not_connected" }); return; }
    const cfg = (ti.config && typeof ti.config === "object" ? ti.config : {}) as Record<string, unknown>;
    res.json({
      data: {
        baseId: cfg.baseId ?? null,
        tableId: cfg.tableId ?? null,
        tableName: cfg.tableName ?? null,
        fieldMap: cfg.fieldMap ?? {},
        notesField: cfg.notesField ?? null,
        idempotencyField: cfg.idempotencyField ?? null,
      },
    });
  },
);

// Save the mapping onto the connection config. Optionally auto-create the
// notes / idempotency columns we OWN (never identifier columns) when
// create_missing=true and the token carries schema.bases:write.
router.post(
  "/connectors/airtable/mapping",
  authenticate, resolveTenant, requireOnboardingOrActiveTenant(), canConnectSystems,
  async (req: Request, res: Response) => {
    const cat = await findCatalog("airtable");
    if (!cat) { res.status(404).json({ error: "unknown_provider" }); return; }
    const ti = await (prisma as any).tenantIntegration.findUnique({
      where: { tenantId_integrationId: { tenantId: req.tenantId, integrationId: cat.id } },
    });
    if (!ti) { res.status(400).json({ error: "not_connected" }); return; }

    const { baseId, tableId, fieldMap, notesField, idempotencyField, createMissing } = req.body || {};
    if (!baseId || !tableId) { res.status(400).json({ error: "baseId_and_tableId_required" }); return; }
    const fm = (fieldMap && typeof fieldMap === "object") ? fieldMap : {};
    if (!fm.email && !fm.phone) { res.status(400).json({ error: "map_email_or_phone" }); return; }
    if (!fm.display_name) { res.status(400).json({ error: "map_display_name" }); return; }

    let finalNotesField: string | undefined = notesField || undefined;
    let finalIdempotencyField: string | undefined = idempotencyField || undefined;
    let warning: string | undefined;

    if (createMissing && (!finalNotesField || !finalIdempotencyField)) {
      const token = await airtableToken(req.tenantId!);
      if (!token) {
        warning = "not_connected_for_create";
      } else {
        try {
          if (!finalNotesField) finalNotesField = (await airtableCreateField(token, baseId, tableId, "Notes (Gotcha)", "multilineText")).name;
          if (!finalIdempotencyField) finalIdempotencyField = (await airtableCreateField(token, baseId, tableId, "Gotcha Source ID", "singleLineText")).name;
        } catch (e: any) {
          warning = `create_field_failed:${(e?.message || "").slice(0, 120)}`;
        }
      }
    }

    const cfg = (ti.config && typeof ti.config === "object" ? ti.config : {}) as Record<string, unknown>;
    cfg.baseId = baseId;
    cfg.tableId = tableId;
    cfg.fieldMap = { email: fm.email, phone: fm.phone, display_name: fm.display_name, stage: fm.stage };
    if (finalNotesField) cfg.notesField = finalNotesField;
    if (finalIdempotencyField) cfg.idempotencyField = finalIdempotencyField;
    const updated = await (prisma as any).tenantIntegration.update({ where: { id: ti.id }, data: { config: cfg } });
    res.json({ data: { id: updated.id, config: cfg }, ...(warning ? { warning } : {}) });
  },
);

// ─── Wix App OAuth (install flow - multi-tenant) ─────────────
//
// CORRECT flow for "any Wix store owner connects their store to us":
//   1. We send the user to https://www.wix.com/installer/install?appId=…
//      &redirectUrl=…&state=… - Wix shows them a "Add to site" picker.
//   2. After they pick a site + approve permissions, Wix redirects back to
//      our callback with `?code=…&instanceId=<site-instance>&state=…`.
//   3. We POST that code to https://www.wixapis.com/oauth/access
//      (grant_type=authorization_code) for an access_token + refresh_token
//      scoped to that instanceId.
//
// We persist `instanceId` on the integration so subsequent API calls can
// reference the right Wix site. Refresh tokens are long-lived (Wix handles
// expiry transparently - token expiry is ~5 minutes, refresh-token rotation
// is one-shot per refresh).

router.get(
  "/connectors/wix/oauth/init",
  // Onboarding-reachable like every other connector: during onboarding the
  // tenant is PENDING_ONBOARDING, and requireActiveTenant() 403s there.
  authenticate, resolveTenant, requireOnboardingOrActiveTenant(), canConnectSystems,
  (req: Request, res: Response) => {
    const appId = process.env.WIX_CLIENT_ID;            // Wix App ID
    const redirect = process.env.WIX_REDIRECT_URI;
    if (!appId || !redirect) { res.status(500).json({ error: "wix_oauth_not_configured" }); return; }
    const { state } = mintOAuthState({ tenantId: req.tenantId!, provider: "wix", userId: (req as any).user?.userId });
    // Wix App install flow - NOT the headless `oauth/authorize` flow.
    const params = new URLSearchParams({
      appId,
      redirectUrl: redirect,
      state,
    });
    res.json({ url: `https://www.wix.com/installer/install?${params.toString()}` });
  },
);

router.get("/connectors/wix/oauth/callback", async (req: Request, res: Response) => {
  try {
    const { code, state, instanceId } = req.query;
    if (!code || !state) { res.status(400).send("missing_code_or_state"); return; }
    const consumed = await consumeOAuthState<any>(state as string, "wix");
    if (!consumed.ok) {
      // Replay and forgery look identical to the caller; only our logs distinguish them.
      console.warn(`[wix oauth] state rejected: ${consumed.reason}`);
      res.status(400).send(consumed.reason === "replayed" ? "state_already_used" : "bad_state");
      return;
    }
    const payload = consumed.claims;
    const clientId = process.env.WIX_CLIENT_ID!;
    const clientSecret = process.env.WIX_CLIENT_SECRET!;
    const tokenRes = await fetch("https://www.wixapis.com/oauth/access", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        code: String(code),
      }),
    });
    if (!tokenRes.ok) {
      const text = await tokenRes.text().catch(() => "");
      res.status(400).send(`token_exchange_failed: ${text.slice(0, 240)}`);
      return;
    }
    const j: any = await tokenRes.json();
    const cat = await findCatalog("wix");
    if (!cat) { res.status(500).send("wix_catalog_missing"); return; }
    await upsertConnection({
      tenantId: payload.tenantId,
      catalogId: cat.id,
      status: "CONNECTED",
      credentialsBlob: encryptCredentials({
        accessToken: j.access_token,
        refreshToken: j.refresh_token,
        expiresAt: j.expires_in ? new Date(Date.now() + Number(j.expires_in) * 1000).toISOString() : undefined,
        instanceId: instanceId ? String(instanceId) : undefined,
      }),
      config: { instanceId: instanceId ? String(instanceId) : undefined },
    });
    res.redirect(dashboardRedirect("wix"));
  } catch (err: any) {
    res.status(500).send(`wix_callback_error:${err?.message || ""}`);
  }
});

// ─── Square OAuth ────────────────────────────────────────────

router.get(
  "/connectors/square/oauth/init",
  // Onboarding-reachable like every other connector: during onboarding the
  // tenant is PENDING_ONBOARDING, and requireActiveTenant() 403s there.
  authenticate, resolveTenant, requireOnboardingOrActiveTenant(), canConnectSystems,
  (req: Request, res: Response) => {
    const clientId = process.env.SQUARE_APPLICATION_ID;
    const redirect = process.env.SQUARE_REDIRECT_URI;
    if (!clientId || !redirect) { res.status(500).json({ error: "square_oauth_not_configured" }); return; }
    const env = String(req.query.environment || "production") === "sandbox" ? "sandbox" : "production";
    const { state } = mintOAuthState({ tenantId: req.tenantId!, provider: "square", env, userId: (req as any).user?.userId });
    const scopes = "PAYMENTS_WRITE PAYMENTS_READ CUSTOMERS_READ CUSTOMERS_WRITE ORDERS_READ ORDERS_WRITE INVOICES_READ INVOICES_WRITE MERCHANT_PROFILE_READ";
    const host = env === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
    const params = new URLSearchParams({
      client_id: clientId,
      scope: scopes,
      session: "false",
      state,
      redirect_uri: redirect,
    });
    res.json({ url: `${host}/oauth2/authorize?${params.toString()}` });
  },
);

router.get("/connectors/square/oauth/callback", async (req: Request, res: Response) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) { res.status(400).send("missing_code_or_state"); return; }
    const consumed = await consumeOAuthState<any>(state as string, "square");
    if (!consumed.ok) {
      // Replay and forgery look identical to the caller; only our logs distinguish them.
      console.warn(`[square oauth] state rejected: ${consumed.reason}`);
      res.status(400).send(consumed.reason === "replayed" ? "state_already_used" : "bad_state");
      return;
    }
    const payload = consumed.claims;
    const env = payload.env === "sandbox" ? "sandbox" : "production";
    const host = env === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
    const clientId = process.env.SQUARE_APPLICATION_ID!;
    const clientSecret = process.env.SQUARE_APPLICATION_SECRET!;
    const tokenRes = await fetch(`${host}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Square-Version": "2024-08-21" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code: String(code),
        grant_type: "authorization_code",
      }),
    });
    if (!tokenRes.ok) { res.status(400).send("token_exchange_failed"); return; }
    const j: any = await tokenRes.json();
    const cat = await findCatalog("square");
    if (!cat) { res.status(500).send("square_catalog_missing"); return; }
    await upsertConnection({
      tenantId: payload.tenantId,
      catalogId: cat.id,
      status: "CONNECTED",
      credentialsBlob: encryptCredentials({
        accessToken: j.access_token,
        refreshToken: j.refresh_token,
        expiresAt: j.expires_at,
        merchantId: j.merchant_id,
        environment: env,
      }),
      config: { environment: env },
    });
    res.redirect(dashboardRedirect("square"));
  } catch (err: any) {
    res.status(500).send(`square_callback_error:${err?.message || ""}`);
  }
});

// ─── Salesforce OAuth ────────────────────────────────────────

router.get(
  "/connectors/salesforce/oauth/init",
  authenticate, resolveTenant, requireOnboardingOrActiveTenant(), canConnectSystems,
  (req: Request, res: Response) => {
    const clientId = process.env.SALESFORCE_CLIENT_ID;
    const redirect = process.env.SALESFORCE_REDIRECT_URI;
    if (!clientId || !redirect) { res.status(500).json({ error: "salesforce_oauth_not_configured" }); return; }
    const loginHost = String(req.query.loginHost || "https://login.salesforce.com");
    if (!/^https:\/\/(login|test)\.salesforce\.com$/.test(loginHost)) {
      res.status(400).json({ error: "bad_login_host (use login.salesforce.com or test.salesforce.com)" });
      return;
    }
    const flow = parseFlow(req.query.flow);
    const { state } = mintOAuthState({ tenantId: req.tenantId!, provider: "salesforce", loginHost, flow, userId: (req as any).user?.userId });
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirect,
      scope: "api refresh_token offline_access",
      state,
    });
    res.json({ url: `${loginHost}/services/oauth2/authorize?${params.toString()}` });
  },
);

router.get("/connectors/salesforce/oauth/callback", async (req: Request, res: Response) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) { res.status(400).send("missing_code_or_state"); return; }
    const consumed = await consumeOAuthState<any>(state as string, "salesforce");
    if (!consumed.ok) {
      // Replay and forgery look identical to the caller; only our logs distinguish them.
      console.warn(`[salesforce oauth] state rejected: ${consumed.reason}`);
      res.status(400).send(consumed.reason === "replayed" ? "state_already_used" : "bad_state");
      return;
    }
    const payload = consumed.claims;
    const clientId = process.env.SALESFORCE_CLIENT_ID!;
    const clientSecret = process.env.SALESFORCE_CLIENT_SECRET!;
    const redirect = process.env.SALESFORCE_REDIRECT_URI!;
    const loginHost = String(payload.loginHost || "https://login.salesforce.com");
    const tokenRes = await fetch(`${loginHost}/services/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirect,
        code: String(code),
      }).toString(),
    });
    if (!tokenRes.ok) { res.status(400).send("token_exchange_failed"); return; }
    const j: any = await tokenRes.json();
    const cat = await findCatalog("salesforce");
    if (!cat) { res.status(500).send("salesforce_catalog_missing"); return; }
    await upsertConnection({
      tenantId: payload.tenantId,
      catalogId: cat.id,
      status: "CONNECTED",
      credentialsBlob: encryptCredentials({
        accessToken: j.access_token,
        refreshToken: j.refresh_token,
        instanceUrl: j.instance_url,
        loginHost,
        scope: j.scope,
      }),
      config: { instanceUrl: j.instance_url, loginHost },
    });
    res.redirect(postOAuthRedirect("salesforce", payload.flow));
  } catch (err: any) {
    res.status(500).send(`salesforce_callback_error:${err?.message || ""}`);
  }
});

// ─── Monday.com OAuth ────────────────────────────────────────

router.get(
  "/connectors/monday/oauth/init",
  // Onboarding-reachable: during onboarding the tenant is PENDING_ONBOARDING,
  // so requireActiveTenant() answered 403 and the connect simply died there.
  authenticate, resolveTenant, requireOnboardingOrActiveTenant(), canConnectSystems,
  (req: Request, res: Response) => {
    const clientId = process.env.MONDAY_CLIENT_ID;
    const redirect = process.env.MONDAY_REDIRECT_URI;
    if (!clientId || !redirect) { res.status(500).json({ error: "monday_oauth_not_configured" }); return; }
    // SINGLE-USE state. `flow` and the initiating user ride INSIDE the signed
    // token (never a browser-supplied return URL), and the jti is consumed on
    // callback so a captured state cannot be replayed within its TTL.
    const { state } = mintOAuthState({
      tenantId: req.tenantId!,
      provider: "monday",
      userId: (req as any).user?.userId ?? (req as any).userId,
      flow: parseFlow(req.query.flow),
    });
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirect,
      state,
      scope: "boards:read boards:write updates:write",
    });
    res.json({ url: `https://auth.monday.com/oauth2/authorize?${params.toString()}` });
  },
);

router.get("/connectors/monday/oauth/callback", async (req: Request, res: Response) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) { res.status(400).send("missing_code_or_state"); return; }
    const consumed = await consumeOAuthState<{ tenantId: string; flow?: string }>(state as string, "monday");
    if (!consumed.ok) {
      // Replay and forgery are reported identically to the browser; the reason
      // is distinguishable only in our logs.
      console.warn(`[monday oauth] state rejected: ${consumed.reason}`);
      res.status(400).send(consumed.reason === "replayed" ? "state_already_used" : "bad_state");
      return;
    }
    const payload = consumed.claims;
    const clientId = process.env.MONDAY_CLIENT_ID!;
    const clientSecret = process.env.MONDAY_CLIENT_SECRET!;
    const redirect = process.env.MONDAY_REDIRECT_URI!;
    const tokenRes = await fetch("https://auth.monday.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirect,
        code: String(code),
      }).toString(),
    });
    if (!tokenRes.ok) { res.status(400).send("token_exchange_failed"); return; }
    const j: any = await tokenRes.json();
    const cat = await findCatalog("monday");
    if (!cat) { res.status(500).send("monday_catalog_missing"); return; }

    // A token in hand is NOT a working connection. Prove the credential can
    // actually read from Monday before we persist CONNECTED - otherwise the
    // tile claims success and every tool call fails later.
    const probe = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: j.access_token },
      body: JSON.stringify({ query: "query { me { id } }" }),
    }).catch(() => null);
    const probeJson: any = probe && probe.ok ? await probe.json().catch(() => null) : null;
    const verified = !!probeJson?.data?.me?.id;

    await upsertConnection({
      tenantId: payload.tenantId,
      catalogId: cat.id,
      // Persist the credential either way (so a retry does not restart the
      // whole OAuth dance), but only claim CONNECTED when the provider
      // confirmed it. ERROR surfaces in the UI as "needs attention".
      status: verified ? "CONNECTED" : "ERROR",
      credentialsBlob: encryptCredentials({
        accessToken: j.access_token,
        refreshToken: j.refresh_token,
        expiresAt: j.expires_in ? new Date(Date.now() + Number(j.expires_in) * 1000).toISOString() : undefined,
        scope: j.scope,
      }),
      ...(verified ? {} : { lastError: "monday_validation_failed: token accepted but api.monday.com/v2 me{} query did not return an account" }),
    });
    res.redirect(postOAuthRedirect("monday", payload.flow, verified ? {} : { error: "validation_failed" }));
  } catch (err: any) {
    res.status(500).send(`monday_callback_error:${err?.message || ""}`);
  }
});

router.get(
  "/connectors/monday/meta/boards",
  authenticate, resolveTenant, requireActiveTenant(), canConnectSystems,
  async (req: Request, res: Response) => {
    try {
      const cat = await findCatalog("monday");
      if (!cat) { res.status(404).json({ error: "monday_catalog_missing" }); return; }
      const ti: any = await (prisma as any).tenantIntegration.findUnique({
        where: { tenantId_integrationId: { tenantId: req.tenantId!, integrationId: cat.id } },
      });
      if (!ti || ti.status !== "CONNECTED") { res.status(400).json({ error: "not_connected" }); return; }
      const { decryptCredentials } = await import("@chatcenter/shared");
      const creds = typeof ti.credentials === "string" ? decryptCredentials(ti.credentials) : (ti.credentials || {});
      const boards = await mondayListBoards(creds.accessToken);
      res.json({ data: boards });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || "monday_meta_failed" });
    }
  },
);

// ─── DB schema introspection ─────────────────────────────────
//
// POST endpoints (not GET) so connection strings stay out of access logs +
// referer headers. Each handler accepts the connection string in the body -
// either freshly typed (during the connect form) or null to reuse what's
// already stored on the tenant's CONNECTED integration.

async function resolveConnectionString(opts: {
  tenantId: string;
  slug: string;
  bodyConnStr?: string;
}): Promise<string | null> {
  if (opts.bodyConnStr && typeof opts.bodyConnStr === "string") return opts.bodyConnStr;
  const cat = await findCatalog(opts.slug);
  if (!cat) return null;
  const ti: any = await (prisma as any).tenantIntegration.findUnique({
    where: { tenantId_integrationId: { tenantId: opts.tenantId, integrationId: cat.id } },
  });
  if (!ti || ti.status !== "CONNECTED") return null;
  const { decryptCredentials } = await import("@chatcenter/shared");
  const creds = typeof ti.credentials === "string"
    ? decryptCredentials(ti.credentials)
    : (ti.credentials || {});
  return creds.connectionString || creds.connection_string || null;
}

router.post(
  "/connectors/postgres/meta/tables",
  authenticate, resolveTenant, requireActiveTenant(), canConnectSystems,
  async (req: Request, res: Response) => {
    const connStr = await resolveConnectionString({
      tenantId: req.tenantId!,
      slug: "postgresql",
      bodyConnStr: req.body?.connectionString,
    });
    if (!connStr) { res.status(400).json({ error: "no_connection_string" }); return; }
    try {
      const { Pool } = await import("pg");
      const pool = new Pool({
        connectionString: connStr,
        max: 1,
        connectionTimeoutMillis: 5000,
        statement_timeout: 5000,
      });
      try {
        const r = await pool.query<{ table_schema: string; table_name: string }>(
          `SELECT table_schema, table_name
           FROM information_schema.tables
           WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
             AND table_type IN ('BASE TABLE', 'VIEW')
           ORDER BY table_schema, table_name`,
        );
        res.json({
          data: r.rows.map((row) => ({
            name: row.table_name,
            schema: row.table_schema,
            qualified: row.table_schema === "public" ? row.table_name : `${row.table_schema}.${row.table_name}`,
          })),
        });
      } finally {
        await pool.end();
      }
    } catch (err: any) {
      res.status(400).json({ error: `postgres_meta_failed: ${err?.message || "unknown"}` });
    }
  },
);

router.post(
  "/connectors/mongodb/meta/collections",
  authenticate, resolveTenant, requireActiveTenant(), canConnectSystems,
  async (req: Request, res: Response) => {
    const connStr = await resolveConnectionString({
      tenantId: req.tenantId!,
      slug: "mongodb",
      bodyConnStr: req.body?.connectionString,
    });
    if (!connStr) { res.status(400).json({ error: "no_connection_string" }); return; }
    const dbName = req.body?.dbName;
    if (!dbName) { res.status(400).json({ error: "dbName_required" }); return; }
    try {
      const { MongoClient } = await import("mongodb");
      const client = new MongoClient(connStr, { connectTimeoutMS: 5000, serverSelectionTimeoutMS: 5000 });
      try {
        await client.connect();
        const collections = await client.db(String(dbName)).listCollections({}, { nameOnly: true }).toArray();
        res.json({
          data: collections.map((c: any) => ({ name: c.name })).filter((c: any) => !c.name.startsWith("system.")),
        });
      } finally {
        await client.close().catch(() => undefined);
      }
    } catch (err: any) {
      res.status(400).json({ error: `mongodb_meta_failed: ${err?.message || "unknown"}` });
    }
  },
);

router.post(
  "/connectors/mongodb/meta/databases",
  authenticate, resolveTenant, requireActiveTenant(), canConnectSystems,
  async (req: Request, res: Response) => {
    const connStr = await resolveConnectionString({
      tenantId: req.tenantId!,
      slug: "mongodb",
      bodyConnStr: req.body?.connectionString,
    });
    if (!connStr) { res.status(400).json({ error: "no_connection_string" }); return; }
    try {
      const { MongoClient } = await import("mongodb");
      const client = new MongoClient(connStr, { connectTimeoutMS: 5000, serverSelectionTimeoutMS: 5000 });
      try {
        await client.connect();
        const admin = client.db().admin();
        const dbs = await admin.listDatabases();
        res.json({
          data: (dbs.databases || [])
            .map((d: any) => ({ name: d.name }))
            .filter((d: any) => !["admin", "local", "config"].includes(d.name)),
        });
      } finally {
        await client.close().catch(() => undefined);
      }
    } catch (err: any) {
      res.status(400).json({ error: `mongodb_meta_failed: ${err?.message || "unknown"}` });
    }
  },
);

router.post(
  "/connectors/aws_rds/meta/tables",
  authenticate, resolveTenant, requireActiveTenant(), canConnectSystems,
  async (req: Request, res: Response) => {
    const connStr = await resolveConnectionString({
      tenantId: req.tenantId!,
      slug: "aws_rds",
      bodyConnStr: req.body?.connectionString,
    });
    if (!connStr) { res.status(400).json({ error: "no_connection_string" }); return; }
    const engine = String(req.body?.engine || "postgres").toLowerCase();
    try {
      if (engine === "mysql" || engine === "mariadb") {
        // mysql2 is loaded lazily - avoids requiring it on Postgres-only deploys.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const m = require("mysql2/promise");
        const conn = await m.createConnection({
          uri: connStr,
          connectTimeout: 5000,
          ssl: /\.rds\.amazonaws\.com/i.test(connStr) ? { rejectUnauthorized: false } : undefined,
        });
        try {
          const [rows]: any = await conn.query(
            "SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS table_name FROM information_schema.tables WHERE TABLE_SCHEMA NOT IN ('mysql','information_schema','performance_schema','sys') ORDER BY TABLE_SCHEMA, TABLE_NAME",
          );
          res.json({
            data: (rows || []).map((row: any) => ({
              name: row.table_name,
              schema: row.schema_name,
              qualified: `${row.schema_name}.${row.table_name}`,
            })),
          });
        } finally {
          await conn.end().catch(() => undefined);
        }
        return;
      }
      const { Pool } = await import("pg");
      const pool = new Pool({
        connectionString: connStr,
        max: 1,
        connectionTimeoutMillis: 5000,
        statement_timeout: 5000,
        ssl: /\.rds\.amazonaws\.com/i.test(connStr) ? { rejectUnauthorized: false } : undefined,
      });
      try {
        const r = await pool.query<{ table_schema: string; table_name: string }>(
          `SELECT table_schema, table_name
           FROM information_schema.tables
           WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
             AND table_type IN ('BASE TABLE', 'VIEW')
           ORDER BY table_schema, table_name`,
        );
        res.json({
          data: r.rows.map((row) => ({
            name: row.table_name,
            schema: row.table_schema,
            qualified: row.table_schema === "public" ? row.table_name : `${row.table_schema}.${row.table_name}`,
          })),
        });
      } finally {
        await pool.end();
      }
    } catch (err: any) {
      res.status(400).json({ error: `aws_rds_meta_failed: ${err?.message || "unknown"}` });
    }
  },
);

export default router;
