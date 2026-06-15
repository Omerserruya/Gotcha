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
import jwt from "jsonwebtoken";
import * as crypto from "crypto";
import {
  prisma,
  authenticate,
  resolveTenant,
  requireActiveTenant,
  requireOnboardingOrActiveTenant,
  requireRole,
  encryptCredentials,
} from "@chatcenter/shared";
import { airtableListBases, airtableListTables, airtableListFields, airtableCreateField } from "../services/connectors/airtable.adapter";
import { mondayListBoards } from "../services/connectors/monday.adapter";
import { loadConnection } from "../services/connectors/integration-framework";

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || "change-me";

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
}) {
  const data: any = {
    status: opts.status,
    connectedAt: new Date(),
    lastTestedAt: new Date(),
    lastTestResult: opts.status === "CONNECTED",
    lastError: null,
  };
  if (opts.credentialsBlob !== undefined) data.credentials = opts.credentialsBlob;
  if (opts.config !== undefined) data.config = opts.config;
  if (opts.connectedBy !== undefined) data.connectedBy = opts.connectedBy;

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
  return await (prisma as any).tenantIntegration.upsert({
    where: { tenantId_integrationId: { tenantId: opts.tenantId, integrationId: opts.catalogId } },
    update: data,
    create,
  });
}

function dashboardRedirect(slug: string, query: Record<string, string> = {}) {
  const params = new URLSearchParams({ status: "connected", ...query });
  const path = `/ai-studio/marketplace/${slug}?${params.toString()}`;
  return process.env.DASHBOARD_URL ? `${process.env.DASHBOARD_URL}${path}` : path;
}

// Where to land after an OAuth round-trip. When the connect was kicked off
// from onboarding (state carries flow:"onboarding"), return to /setup so the
// boot logic detects the connected core system and finishes activation.
// Otherwise fall through to the marketplace page for the provider.
function postOAuthRedirect(slug: string, flow: string | undefined, query: Record<string, string> = {}) {
  if (flow === "onboarding") {
    const base = process.env.FRONTEND_URL || process.env.DASHBOARD_URL || "";
    const params = new URLSearchParams({ connected: slug, ...query });
    return `${base}/setup?${params.toString()}`;
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
  authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"),
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
  authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"),
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
  authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"),
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

router.post(
  "/connectors/:slug/connect",
  authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"),
  async (req: Request, res: Response) => {
    const cat = await findCatalog(req.params.slug);
    if (!cat) { res.status(404).json({ error: "unknown_provider" }); return; }
    const credentials = req.body?.credentials || {};
    const config = req.body?.config || {};
    if (!credentials || Object.keys(credentials).length === 0) {
      res.status(400).json({ error: "credentials_required" });
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
  authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"),
  (req: Request, res: Response) => {
    const clientId = process.env.STRIPE_CLIENT_ID;
    const redirect = process.env.STRIPE_REDIRECT_URI;
    if (!clientId || !redirect) { res.status(500).json({ error: "stripe_oauth_not_configured" }); return; }
    const state = jwt.sign({ tenantId: req.tenantId, provider: "stripe" }, JWT_SECRET, { expiresIn: "10m" });
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
    const payload = jwt.verify(state as string, JWT_SECRET) as any;
    if (payload.provider !== "stripe") { res.status(400).send("bad_state"); return; }

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
  authenticate, resolveTenant, requireOnboardingOrActiveTenant(), requireRole("ADMIN"),
  (req: Request, res: Response) => {
    const clientId = process.env.HUBSPOT_CLIENT_ID;
    const redirect = process.env.HUBSPOT_REDIRECT_URI;
    if (!clientId || !redirect) { res.status(500).json({ error: "hubspot_oauth_not_configured" }); return; }
    const flow = req.query.flow === "onboarding" ? "onboarding" : undefined;
    const state = jwt.sign({ tenantId: req.tenantId, provider: "hubspot", flow }, JWT_SECRET, { expiresIn: "10m" });
    // Includes Leads scopes - they 403 silently for tenants on Pro/Starter
    // (no Leads object). Leaving them in keeps Enterprise install fast.
    const scope = [
      "crm.objects.contacts.read",
      "crm.objects.contacts.write",
      "crm.objects.deals.read",
      "crm.objects.deals.write",
      "crm.objects.leads.read",
      "crm.objects.leads.write",
      "oauth",
    ].join(" ");
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirect,
      scope,
      state,
    });
    res.json({ url: `https://app.hubspot.com/oauth/authorize?${params.toString()}` });
  },
);

router.get("/connectors/hubspot/oauth/callback", async (req: Request, res: Response) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) { res.status(400).send("missing_code_or_state"); return; }
    const payload = jwt.verify(state as string, JWT_SECRET) as any;
    if (payload.provider !== "hubspot") { res.status(400).send("bad_state"); return; }

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
  authenticate, resolveTenant, requireOnboardingOrActiveTenant(), requireRole("ADMIN"),
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
    const flow = req.query.flow === "onboarding" ? "onboarding" : undefined;
    const state = jwt.sign({ tenantId: req.tenantId, provider: "shopify", shop, flow }, JWT_SECRET, { expiresIn: "10m" });
    const scopes = "read_orders,write_orders,read_customers,write_discounts,read_products,read_returns";
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
    const payload = jwt.verify(state as string, JWT_SECRET) as any;
    if (payload.provider !== "shopify" || payload.shop !== shop) { res.status(400).send("bad_state"); return; }

    const clientId = process.env.SHOPIFY_API_KEY!;
    const clientSecret = process.env.SHOPIFY_API_SECRET!;

    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
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
        scope: j.scope,
        shopDomain: shop,
      }),
      config: { shopDomain: shop },
    });
    res.redirect(postOAuthRedirect("shopify", payload.flow));
  } catch (err: any) {
    res.status(500).send(`shopify_callback_error:${err?.message || ""}`);
  }
});

// ─── Airtable meta selectors ─────────────────────────────────

router.get(
  "/connectors/airtable/meta/bases",
  authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"),
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
  authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"),
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
  authenticate, resolveTenant, requireOnboardingOrActiveTenant(), requireRole("ADMIN"),
  (req: Request, res: Response) => {
    const clientId = process.env.AIRTABLE_CLIENT_ID;
    const redirect = process.env.AIRTABLE_REDIRECT_URI;
    if (!clientId || !redirect) { res.status(500).json({ error: "airtable_oauth_not_configured" }); return; }
    const flow = req.query.flow === "onboarding" ? "onboarding" : undefined;
    const verifier = base64url(crypto.randomBytes(48));
    const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
    const state = jwt.sign({ tenantId: req.tenantId, provider: "airtable", flow, v: verifier }, JWT_SECRET, { expiresIn: "10m" });
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
    const payload = jwt.verify(state as string, JWT_SECRET) as any;
    if (payload.provider !== "airtable") { res.status(400).send("bad_state"); return; }
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
  authenticate, resolveTenant, requireOnboardingOrActiveTenant(), requireRole("ADMIN"),
  async (req: Request, res: Response) => {
    const token = await airtableToken(req.tenantId!);
    if (!token) { res.status(400).json({ error: "not_connected" }); return; }
    try { res.json({ data: await airtableListBases(token) }); }
    catch (e: any) { res.status(400).json({ error: e?.message || "airtable_meta_failed" }); }
  },
);

router.get(
  "/connectors/airtable/oauth/tables",
  authenticate, resolveTenant, requireOnboardingOrActiveTenant(), requireRole("ADMIN"),
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
  authenticate, resolveTenant, requireOnboardingOrActiveTenant(), requireRole("ADMIN"),
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
  authenticate, resolveTenant, requireOnboardingOrActiveTenant(), requireRole("ADMIN"),
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
  authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"),
  (req: Request, res: Response) => {
    const appId = process.env.WIX_CLIENT_ID;            // Wix App ID
    const redirect = process.env.WIX_REDIRECT_URI;
    if (!appId || !redirect) { res.status(500).json({ error: "wix_oauth_not_configured" }); return; }
    const state = jwt.sign({ tenantId: req.tenantId, provider: "wix" }, JWT_SECRET, { expiresIn: "10m" });
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
    const payload = jwt.verify(state as string, JWT_SECRET) as any;
    if (payload.provider !== "wix") { res.status(400).send("bad_state"); return; }
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
  authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"),
  (req: Request, res: Response) => {
    const clientId = process.env.SQUARE_APPLICATION_ID;
    const redirect = process.env.SQUARE_REDIRECT_URI;
    if (!clientId || !redirect) { res.status(500).json({ error: "square_oauth_not_configured" }); return; }
    const env = String(req.query.environment || "production") === "sandbox" ? "sandbox" : "production";
    const state = jwt.sign({ tenantId: req.tenantId, provider: "square", env }, JWT_SECRET, { expiresIn: "10m" });
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
    const payload = jwt.verify(state as string, JWT_SECRET) as any;
    if (payload.provider !== "square") { res.status(400).send("bad_state"); return; }
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
  authenticate, resolveTenant, requireOnboardingOrActiveTenant(), requireRole("ADMIN"),
  (req: Request, res: Response) => {
    const clientId = process.env.SALESFORCE_CLIENT_ID;
    const redirect = process.env.SALESFORCE_REDIRECT_URI;
    if (!clientId || !redirect) { res.status(500).json({ error: "salesforce_oauth_not_configured" }); return; }
    const loginHost = String(req.query.loginHost || "https://login.salesforce.com");
    if (!/^https:\/\/(login|test)\.salesforce\.com$/.test(loginHost)) {
      res.status(400).json({ error: "bad_login_host (use login.salesforce.com or test.salesforce.com)" });
      return;
    }
    const flow = req.query.flow === "onboarding" ? "onboarding" : undefined;
    const state = jwt.sign({ tenantId: req.tenantId, provider: "salesforce", loginHost, flow }, JWT_SECRET, { expiresIn: "10m" });
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
    const payload = jwt.verify(state as string, JWT_SECRET) as any;
    if (payload.provider !== "salesforce") { res.status(400).send("bad_state"); return; }
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
  authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"),
  (req: Request, res: Response) => {
    const clientId = process.env.MONDAY_CLIENT_ID;
    const redirect = process.env.MONDAY_REDIRECT_URI;
    if (!clientId || !redirect) { res.status(500).json({ error: "monday_oauth_not_configured" }); return; }
    const state = jwt.sign({ tenantId: req.tenantId, provider: "monday" }, JWT_SECRET, { expiresIn: "10m" });
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
    const payload = jwt.verify(state as string, JWT_SECRET) as any;
    if (payload.provider !== "monday") { res.status(400).send("bad_state"); return; }
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
    res.redirect(dashboardRedirect("monday"));
  } catch (err: any) {
    res.status(500).send(`monday_callback_error:${err?.message || ""}`);
  }
});

router.get(
  "/connectors/monday/meta/boards",
  authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"),
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
  authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"),
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
  authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"),
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
  authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"),
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
  authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"),
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
