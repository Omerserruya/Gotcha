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
 *   - shopify  (per-shop - `shop` query param required on init)
 * API-key style:
 *   - airtable (PAT)
 *   - postgres / mongodb / aws_rds (connection string)
 *   - any tenant-supplied API key
 *
 * Tokens are encrypted via @chatcenter/shared encryptCredentials.
 */

import { Router, type Request, type Response } from "express";
import * as crypto from "crypto";
import { provisionIntegrationTools } from "../services/integration-provisioning.service";
import { disconnectIntegration } from "../services/integration-lifecycle.service";
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
} from "@chatcenter/shared";
import { airtableListBases, airtableListTables, airtableListFields, airtableCreateField } from "../services/connectors/airtable.adapter";
import { mondayListBoards } from "../services/connectors/monday.adapter";
import { loadConnection, refreshCapabilityState } from "../services/connectors/integration-framework";
import { reconcileAgentToolPermissions } from "../services/tool-permission-reconcile.service";

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

async function findCatalog(slug: string | string[] | undefined) {
  const s = Array.isArray(slug) ? slug[0] : slug;
  if (!s) return null;
  return await (prisma as any).integrationCatalog.findUnique({ where: { slug: String(s) } });
}

async function upsertConnection(opts: {
  tenantId: string;
  catalogId: string;
  status: "CONNECTED" | "ERROR";
  credentialsBlob?: string;
  config?: Record<string, any>;
  connectedBy?: string;
  /** Why the connection is not usable. Persisted so the UI can show an
   *  actionable reason instead of a bare ERROR chip. Cleared on success. */
  lastError?: string;
}) {
  const data: any = {
    status: opts.status,
    connectedAt: new Date(),
    lastTestedAt: new Date(),
    lastTestResult: opts.status === "CONNECTED",
    lastError: opts.status === "CONNECTED" ? null : (opts.lastError ?? null),
  };
  if (opts.credentialsBlob !== undefined) data.credentials = opts.credentialsBlob;
  if (opts.connectedBy !== undefined) data.connectedBy = opts.connectedBy;
  // MERGE config on re-connect, never replace: config carries settings set
  // OUTSIDE the OAuth flow (useAsCrm, sync toggles) - a re-connect passing
  // only { shopDomain } used to wipe them (this is how Urban Supply lost
  // useAsCrm and CRM writeback silently stopped resolving).
  if (opts.config !== undefined) {
    const existing = await (prisma as any).tenantIntegration.findUnique({
      where: { tenantId_integrationId: { tenantId: opts.tenantId, integrationId: opts.catalogId } },
      select: { config: true },
    });
    data.config = { ...(existing?.config ?? {}), ...opts.config };
  }

  const create: any = {
    tenantId: opts.tenantId,
    integrationId: opts.catalogId,
    status: opts.status,
    connectedAt: data.connectedAt,
    lastTestedAt: data.lastTestedAt,
    lastTestResult: data.lastTestResult,
    credentials: opts.credentialsBlob ?? "",
    config: opts.config ?? {},
    connectedBy: opts.connectedBy ?? null,
  };
  const row = await (prisma as any).tenantIntegration.upsert({
    where: { tenantId_integrationId: { tenantId: opts.tenantId, integrationId: opts.catalogId } },
    update: data,
    create,
  });

  // A CONNECTED integration whose tools nobody granted is a connection that
  // does nothing. The AI's tool surface is built from AgentToolPermission
  // rows, and those were only ever created by one UI toggle - so Urban Supply
  // Dev reconnected to grant fulfillment scopes and silently lost every
  // Shopify tool. The connection stayed CONNECTED, the capability probe stayed
  // green, and the assistant answered a size question by asking which colour
  // and escalated a cancellation saying the tooling was unavailable. It was
  // right, and nothing anywhere said so.
  //
  // The FULL surface, not reads only.
  //
  // "Writes stay an explicit decision" is a reasonable sentence about a first
  // connect and a false one about a reconnect: disconnect deletes tenant tools
  // by cascade, so nobody decided anything - a cascade did. Part 6 caught this
  // live, on the day it mattered: an operator reconnected to grant the scopes
  // this round needed, and the reconnect left 42 of 68 tools present with every
  // single missing one a WRITE or an ACTION. Healthy store, green probe, and an
  // assistant that could look up any order and act on none.
  //
  // That is worse than having no tools, because the reads answer every
  // diagnostic anyone thinks to run - and reconnecting is the ONLY way to grant
  // a scope, so the operation that makes an assistant more capable is the one
  // that quietly disarms it.
  //
  // What keeps writes safe is where it always was: hitl_policy holds every
  // money-moving tool behind a human. Never a downgrade either - a row an
  // operator switched off is skipped, not re-enabled.
  //
  // Best-effort - a provisioning hiccup must not fail an otherwise good
  // connection, and the next connect retries it.
  if (opts.status === "CONNECTED") {
    try {
      const r = await provisionIntegrationTools(opts.tenantId, row.id, opts.catalogId, { reason: "connect" });
      if (r.granted > 0 || r.preserved > 0) {
        console.log(
          `[connectors] provisioned ${r.granted} tool permission(s) on connect for tenant=${opts.tenantId} ` +
            `(${JSON.stringify(r.byCategory)}, ${r.preserved} left as the operator set them)`,
        );
      }
    } catch (err: any) {
      console.error("[connectors] tool provisioning failed on connect:", err?.message);
    }
  }
  return row;
}

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
  const base = process.env.FRONTEND_URL || process.env.DASHBOARD_URL || "";
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
    // This route used to flip the status and stop, leaving the encrypted
    // credentials in place - so an integration the product called
    // "disconnected" still held a usable access token. The other disconnect
    // route had the mirror-image bug: it cleared credentials and deleted the
    // tenant's tool policy. Both now go through one function, which clears the
    // credentials AND keeps the policy.
    const ti = await (prisma as any).tenantIntegration.findUnique({
      where: { tenantId_integrationId: { tenantId: req.tenantId, integrationId: cat.id } },
    });
    if (!ti) { res.json({ ok: true, alreadyDisconnected: true }); return; }
    const result = await disconnectIntegration({
      tenantId: req.tenantId!,
      tenantIntegrationId: ti.id,
      slug: String(req.params.slug),
      actorId: (req as any).userId ?? null,
    });
    res.json({ ok: true, policyRowsPreserved: result.policyRowsPreserved });
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

// ─── Shopify OAuth (per-shop) ────────────────────────────────

router.get(
  "/connectors/shopify/oauth/init",
  authenticate, resolveTenant, requireOnboardingOrActiveTenant(), canConnectSystems,
  (req: Request, res: Response) => {
    const clientId = process.env.SHOPIFY_API_KEY;
    const redirect = process.env.SHOPIFY_REDIRECT_URI;
    if (!clientId || !redirect) { res.status(500).json({ error: "shopify_oauth_not_configured" }); return; }
    // Forgiving normalization: users paste anything from "my-store" to
    // "https://my-store.myshopify.com/admin/" - strip protocol, path, and
    // whitespace, then auto-append .myshopify.com if they only typed a slug.
    const raw = String(req.query.shop || "").trim().toLowerCase();
    const stripped = raw
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .replace(/\.myshopify\.com$/, "");
    const shop = stripped ? `${stripped}.myshopify.com` : "";
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
      res.status(400).json({ error: "shop_required (e.g. my-store or my-store.myshopify.com)" });
      return;
    }
    const flow = parseFlow(req.query.flow);
    const { state } = mintOAuthState({ tenantId: req.tenantId!, provider: "shopify", shop, flow, userId: (req as any).user?.userId });
    // Discount tools talk to the REST PriceRule/DiscountCode resources
    // (/price_rules.json, /discount_codes/lookup.json), which are gated on
    // read_price_rules / write_price_rules. `write_discounts` covers the newer
    // GraphQL Discounts API instead, so every discount tool - list_discounts,
    // validate_discount, get_customer_discounts, the coupon writers - 403'd with
    // "requires merchant approval for read_price_rules scope" no matter what.
    // Existing connections keep their old grant: re-connect to pick these up.
    // FULFILLMENT ORDERS, INVENTORY and CUSTOMER WRITES were all missing here.
    // Urban Supply Dev only had them because they were added by hand in the
    // Partner dashboard; a merchant connecting through this flow got a
    // connection that read every order as unfulfilled, answered "nothing has
    // shipped" for orders in fulfillment, and offered to cancel orders Shopify
    // would refuse. The list below is what the tool surface actually calls.
    //
    // `write_returns` and `write_order_edits` were on the not-requested list
    // with the note "no tool creates an RMA / edits an order". Both tools now
    // exist, and the note outliving the fact is how the exchange reached a
    // live store and failed at orderEditBegin with "Requires
    // `write_order_edits` access scope" - after eligibility passed, after the
    // price was quoted, after a human approved it. A scope list that is a
    // comment about the past rather than a statement about the surface fails
    // exactly this way: silently, and only at the last step.
    //
    // Deliberately NOT requested: write_fulfillments (no tool creates a
    // fulfillment), write_draft_orders and read_draft_orders (no draft-order
    // tool exists), and the third-party fulfillment-order scopes (only
    // meaningful for merchants using a 3PL - read_assigned_fulfillment_orders
    // is requested for that case, and a merchant without one loses nothing by
    // granting it).
    const scopes = [
      "read_orders", "write_orders",
      // Orders older than 60 days are invisible to read_orders alone, and a
      // customer asking about last season's order is an ordinary request.
      "read_all_orders",
      "read_customers", "write_customers",
      "read_merchant_managed_fulfillment_orders",
      "read_assigned_fulfillment_orders",
      "read_inventory",
      "read_price_rules", "write_price_rules",
      "write_discounts",
      "read_products",
      "read_returns", "write_returns",
      "write_order_edits",
    ].join(",");
    const params = new URLSearchParams({
      client_id: clientId,
      scope: scopes,
      redirect_uri: redirect,
      state,
    });
    res.json({ url: `https://${shop}/admin/oauth/authorize?${params.toString()}` });
  },
);

router.get("/connectors/shopify/oauth/callback", async (req: Request, res: Response) => {
  try {
    const { code, state, shop } = req.query;
    if (!code || !state || !shop) { res.status(400).send("missing_code_or_state_or_shop"); return; }
    const consumed = await consumeOAuthState<any>(state as string, "shopify");
    if (!consumed.ok) {
      // Replay and forgery look identical to the caller; only our logs distinguish them.
      console.warn(`[shopify oauth] state rejected: ${consumed.reason}`);
      res.status(400).send(consumed.reason === "replayed" ? "state_already_used" : "bad_state");
      return;
    }
    const payload = consumed.claims;
    if (payload.shop !== shop) { res.status(400).send("bad_state"); return; }

    const clientId = process.env.SHOPIFY_API_KEY!;
    const clientSecret = process.env.SHOPIFY_API_SECRET!;

    // `expiring: "1"` requests Shopify's expiring offline token (access token
    // + refresh token). Non-expiring tokens are rejected by the Admin API now;
    // the adapter's refreshTokens() keeps the pair rotated.
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, expiring: "1" }),
    });
    if (!tokenRes.ok) { res.status(400).send("token_exchange_failed"); return; }
    const j: any = await tokenRes.json();
    const cat = await findCatalog("shopify");
    if (!cat) { res.status(500).send("shopify_catalog_missing"); return; }
    await upsertConnection({
      tenantId: payload.tenantId,
      catalogId: cat.id,
      status: "CONNECTED",
      credentialsBlob: encryptCredentials({
        accessToken: j.access_token,
        refreshToken: j.refresh_token,
        expiresAt: j.expires_in ? new Date(Date.now() + Number(j.expires_in) * 1000).toISOString() : undefined,
        scope: j.scope,
        shopDomain: shop,
      }),
      config: { shopDomain: shop },
    });
    // Proactive capability discovery: enumerate granted scopes NOW, so a
    // store connected with missing merchant approvals never exposes an
    // unusable write tool for even one turn before the first failure.
    // Fire-and-forget - the redirect must not wait on a Shopify roundtrip.
    void refreshCapabilityState({ tenantId: payload.tenantId, slug: "shopify" }).then((r) => {
      if (r.missingScopes.length) {
        console.warn(`[shopify oauth] connected with missing scopes: ${r.missingScopes.join(",")}`);
      }
    }).catch((e: any) => console.warn("[shopify oauth] capability probe failed:", e?.message));
    // Reconcile existing AI employees' desired tool permissions: employees
    // hired BEFORE Shopify was connected were frozen with a partial tool set
    // and never re-granted this integration's READ tools. Additive/idempotent,
    // READ-only. Fire-and-forget - must not block the redirect.
    void reconcileAgentToolPermissions({ tenantId: payload.tenantId, integrationSlug: "shopify" })
      .then((r) => {
        if (r.added.length) {
          console.log(`[shopify oauth] reconciled ${r.added.length} agent tool grant(s)`);
        }
      })
      .catch((e: any) => console.warn("[shopify oauth] tool-permission reconcile failed:", e?.message));
    res.redirect(postOAuthRedirect("shopify", payload.flow));
  } catch (err: any) {
    res.status(500).send(`shopify_callback_error:${err?.message || ""}`);
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
