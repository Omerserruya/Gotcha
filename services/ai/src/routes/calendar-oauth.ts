/**
 * Calendar OAuth routes (Task 3).
 *
 * Endpoints:
 *   GET  /oauth/google-calendar/init       - start Google OAuth, returns auth URL
 *   GET  /oauth/google-calendar/callback   - finish exchange, persist CalendarAccount
 *   GET  /oauth/calendly/init              - start Calendly OAuth
 *   GET  /oauth/calendly/callback          - finish exchange
 *   POST /api/calendar/disconnect          - revoke local row (status=DISCONNECTED)
 *
 * State carries `{ tenantId, aiAgentId, userId }` signed with OAUTH_STATE_SECRET so
 * the callback can persist the right CalendarAccount row.
 *
 * Tokens are encrypted with `encryptCredentials` before storage. Same
 * pattern as the knowledge / crm OAuth routes.
 */

import { Router, type Request, type Response } from "express";
import {
  prisma,
  authenticate,
  resolveTenant,
  requireOnboardingOrActiveTenant,
  requireRole,
  encryptCredentials,
  getOAuthStateSecret,
  mintOAuthState,
  consumeOAuthState,
} from "@chatcenter/shared";
import jwt from "jsonwebtoken";

const router = Router();
// OAuth `state` signing only - not user auth. See getOAuthStateSecret().
const OAUTH_STATE_SECRET = getOAuthStateSecret();

// ─── Google Calendar ────────────────────────────────────────

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO = "https://www.googleapis.com/oauth2/v3/userinfo";
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
  "openid",
  "email",
].join(" ");

// The marketplace UI calls /api/integrations/oauth/{catalog_slug}/init -
// the catalog slug for this provider is `google_calendar` (underscore).
// We accept BOTH the marketplace path and the dashed alias so direct callers
// (Scheduler settings page) and the marketplace flow both work.
router.get(
  ["/oauth/google_calendar/init", "/oauth/google-calendar/init"],
  authenticate,
  resolveTenant,
  requireOnboardingOrActiveTenant(),
  requireRole("ADMIN"),
  async (req: Request, res: Response) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const redirectUri = process.env.GOOGLE_CALENDAR_REDIRECT_URI;
    if (!clientId || !redirectUri) {
      res.status(500).json({ error: "Google Calendar OAuth not configured" });
      return;
    }
    // aiAgentId is optional. Marketplace UI doesn't pass it; in that case we
    // bind the calendar to the tenant's default agent (or first AI agent).
    const aiAgentId = await resolveAiAgentId(String(req.tenantId), String(req.query.aiAgentId || ""));
    if (!aiAgentId) {
      res.status(400).json({ error: "no AI agent configured for this tenant" });
      return;
    }
    // SINGLE-USE state: `flow` and the initiating user ride inside the SIGNED
    // token (never a browser-supplied return URL), and the jti is burned on
    // callback so a captured state cannot be replayed within its TTL.
    const { state } = mintOAuthState({
      tenantId: req.tenantId!, aiAgentId, userId: (req as any).userId, provider: "google",
      flow: typeof req.query.flow === "string" ? req.query.flow : undefined,
    });
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: GOOGLE_SCOPES,
      access_type: "offline",
      prompt: "consent",
      state,
    });
    res.json({ url: `${GOOGLE_AUTH}?${params.toString()}` });
  },
);

router.get(["/oauth/google_calendar/callback", "/oauth/google-calendar/callback"], async (req: Request, res: Response) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) {
      res.status(400).json({ error: "Missing code or state" });
      return;
    }
    const consumed = await consumeOAuthState<{ tenantId: string; aiAgentId: string; flow?: string }>(state as string, "google");
    if (!consumed.ok) {
      console.warn(`[GCal OAuth] state rejected: ${consumed.reason}`);
      res.status(400).json({ error: consumed.reason === "replayed" ? "state already used" : "invalid state" });
      return;
    }
    const payload = consumed.claims;
    const { tenantId, aiAgentId } = payload;
    const clientId = process.env.GOOGLE_CLIENT_ID!;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;
    const redirectUri = process.env.GOOGLE_CALENDAR_REDIRECT_URI!;

    const tokenRes = await fetch(GOOGLE_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: code as string,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }).toString(),
    });
    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.error("[GCal OAuth] token exchange failed:", err);
      res.status(400).send("Token exchange failed");
      return;
    }
    const tokens: any = await tokenRes.json();

    // Identify the connected Google account.
    let accountEmail: string | null = null;
    try {
      const ui = await fetch(GOOGLE_USERINFO, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
      if (ui.ok) accountEmail = (await ui.json() as any).email ?? null;
    } catch {
      /* email is non-fatal */
    }

    const expiresAt = new Date(Date.now() + Number(tokens.expires_in || 3600) * 1000);
    const credentialsBlob = encryptCredentials({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      scope: tokens.scope,
      tokenType: tokens.token_type,
    });

    await (prisma as any).calendarAccount.upsert({
      where: { aiAgentId_provider: { aiAgentId, provider: "GOOGLE_CALENDAR" } },
      update: {
        credentials: credentialsBlob,
        externalAccountId: accountEmail || aiAgentId,
        accountEmail,
        tokenExpiresAt: expiresAt,
        status: "CONNECTED",
        lastError: null,
      },
      create: {
        tenantId,
        aiAgentId,
        provider: "GOOGLE_CALENDAR",
        credentials: credentialsBlob,
        externalAccountId: accountEmail || aiAgentId,
        accountEmail,
        defaultCalendarId: "primary",
        tokenExpiresAt: expiresAt,
        status: "CONNECTED",
      },
    });

    // Mirror to TenantIntegration so the AI Studio marketplace card reflects
    // the connection. The marketplace UI reads `TenantIntegration.status`
    // and we want it to show CONNECTED next to "Google Calendar" right after
    // the OAuth flow finishes.
    await markMarketplaceConnected(tenantId, "google_calendar", accountEmail);

    res.redirect(connectedRedirect(aiAgentId, "google_calendar", payload.flow));
  } catch (err: any) {
    console.error("[GCal OAuth callback]", err);
    res.status(500).json({ error: err?.message || "callback failed" });
  }
});

// ─── Calendly ──────────────────────────────────────────────

const CALENDLY_AUTH = "https://auth.calendly.com/oauth/authorize";
const CALENDLY_TOKEN = "https://auth.calendly.com/oauth/token";
const CALENDLY_USERS_ME = "https://api.calendly.com/users/me";

router.get(
  "/oauth/calendly/init",
  authenticate,
  resolveTenant,
  requireOnboardingOrActiveTenant(),
  requireRole("ADMIN"),
  async (req: Request, res: Response) => {
    const clientId = process.env.CALENDLY_CLIENT_ID;
    const redirectUri = process.env.CALENDLY_REDIRECT_URI;
    if (!clientId || !redirectUri) {
      res.status(500).json({ error: "Calendly OAuth not configured" });
      return;
    }
    const aiAgentId = await resolveAiAgentId(String(req.tenantId), String(req.query.aiAgentId || ""));
    if (!aiAgentId) {
      res.status(400).json({ error: "no AI agent configured for this tenant" });
      return;
    }
    const { state } = mintOAuthState({
      tenantId: req.tenantId!, aiAgentId, userId: (req as any).userId, provider: "calendly",
      flow: typeof req.query.flow === "string" ? req.query.flow : undefined,
    });
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      state,
    });
    res.json({ url: `${CALENDLY_AUTH}?${params.toString()}` });
  },
);

router.get("/oauth/calendly/callback", async (req: Request, res: Response) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) {
      res.status(400).json({ error: "Missing code or state" });
      return;
    }
    const consumed = await consumeOAuthState<{ tenantId: string; aiAgentId: string; flow?: string }>(state as string, "calendly");
    if (!consumed.ok) {
      console.warn(`[Calendly OAuth] state rejected: ${consumed.reason}`);
      res.status(400).json({ error: consumed.reason === "replayed" ? "state already used" : "invalid state" });
      return;
    }
    const payload = consumed.claims;
    const { tenantId, aiAgentId } = payload;
    const clientId = process.env.CALENDLY_CLIENT_ID!;
    const clientSecret = process.env.CALENDLY_CLIENT_SECRET!;
    const redirectUri = process.env.CALENDLY_REDIRECT_URI!;

    const tokenRes = await fetch(CALENDLY_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code as string,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      }).toString(),
    });
    if (!tokenRes.ok) {
      console.error("[Calendly OAuth] token exchange failed:", await tokenRes.text());
      res.status(400).send("Token exchange failed");
      return;
    }
    const tokens: any = await tokenRes.json();

    // Resolve the user URI - Calendly needs it to scope scheduled-event reads.
    let userUri = "";
    let accountEmail: string | null = null;
    try {
      const me = await fetch(CALENDLY_USERS_ME, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
      if (me.ok) {
        const j = (await me.json()) as any;
        userUri = j?.resource?.uri || "";
        accountEmail = j?.resource?.email ?? null;
      }
    } catch {
      /* non-fatal */
    }

    const expiresAt = new Date(Date.now() + Number(tokens.expires_in || 3600) * 1000);
    const credentialsBlob = encryptCredentials({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      scope: tokens.scope,
      tokenType: tokens.token_type,
    });

    await (prisma as any).calendarAccount.upsert({
      where: { aiAgentId_provider: { aiAgentId, provider: "CALENDLY" } },
      update: {
        credentials: credentialsBlob,
        externalAccountId: userUri || aiAgentId,
        accountEmail,
        tokenExpiresAt: expiresAt,
        status: "CONNECTED",
        lastError: null,
      },
      create: {
        tenantId,
        aiAgentId,
        provider: "CALENDLY",
        credentials: credentialsBlob,
        externalAccountId: userUri || aiAgentId,
        accountEmail,
        tokenExpiresAt: expiresAt,
        status: "CONNECTED",
      },
    });

    await markMarketplaceConnected(tenantId, "calendly", accountEmail);

    res.redirect(connectedRedirect(aiAgentId, "calendly", payload.flow));
  } catch (err: any) {
    console.error("[Calendly OAuth callback]", err);
    res.status(500).json({ error: err?.message || "callback failed" });
  }
});

// ─── Disconnect ────────────────────────────────────────────

router.post(
  "/calendar/disconnect",
  authenticate,
  resolveTenant,
  requireOnboardingOrActiveTenant(),
  requireRole("ADMIN"),
  async (req: Request, res: Response) => {
    const { aiAgentId, provider } = req.body || {};
    if (!aiAgentId || !provider) {
      res.status(400).json({ error: "aiAgentId and provider are required" });
      return;
    }
    await (prisma as any).calendarAccount.updateMany({
      where: { tenantId: req.tenantId, aiAgentId, provider },
      data: { status: "DISCONNECTED" },
    });
    res.json({ ok: true });
  },
);

/**
 * The marketplace OAuth flow doesn't pass `aiAgentId` (it's a tenant-level
 * page). Calendar bindings, however, are per-AI-agent. Resolve to:
 *   1. The aiAgentId provided in the query (Scheduler settings page).
 *   2. Tenant.defaultAgentId (when present).
 *   3. The first AI agent for the tenant (deterministic order).
 *   4. null - caller returns 400.
 */
async function resolveAiAgentId(tenantId: string, fromQuery: string): Promise<string | null> {
  if (fromQuery) return fromQuery;
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { defaultAgentId: true },
    });
    if (tenant?.defaultAgentId) return tenant.defaultAgentId;
  } catch {
    /* fall through */
  }
  const agent = await (prisma as any).aIAgent.findFirst({
    where: { tenantId },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  return agent?.id ?? null;
}

/**
 * After a successful calendar OAuth handshake, mirror the connection status
 * onto the marketplace's TenantIntegration row so the AI Studio card reads
 * "Connected" without a separate sync. Idempotent: upserts on (tenantId,
 * integrationId) and only flips status forward.
 */
async function markMarketplaceConnected(
  tenantId: string,
  catalogSlug: "google_calendar" | "calendly",
  accountEmail: string | null,
): Promise<void> {
  try {
    const catalog = await (prisma as any).integrationCatalog.findUnique({
      where: { slug: catalogSlug },
      select: { id: true },
    });
    if (!catalog?.id) return; // catalog row not seeded yet - nothing to mirror

    await (prisma as any).tenantIntegration.upsert({
      where: { tenantId_integrationId: { tenantId, integrationId: catalog.id } },
      update: {
        status: "CONNECTED",
        connectedAt: new Date(),
        lastTestedAt: new Date(),
        lastTestResult: true,
        lastError: null,
        // Don't store tokens here - they live on CalendarAccount, encrypted.
        // We just keep an empty credentials blob to satisfy the column.
        credentials: { provider: catalogSlug, accountEmail: accountEmail ?? null },
      },
      create: {
        tenantId,
        integrationId: catalog.id,
        status: "CONNECTED",
        connectedAt: new Date(),
        lastTestedAt: new Date(),
        lastTestResult: true,
        credentials: { provider: catalogSlug, accountEmail: accountEmail ?? null },
        config: {},
      },
    });
  } catch (err: any) {
    // Non-fatal: the calendar IS connected; the marketplace card just won't
    // reflect it until the next sync. We don't want to fail the whole OAuth.
    console.warn("[calendar-oauth] failed to mirror to TenantIntegration:", err?.message);
  }
}

/**
 * Where to land the user after the OAuth round-trip. Bounces back to the
 * marketplace integration page so they can configure Meeting Types in
 * place. The provider arg picks the right slug (google_calendar / calendly).
 */
function connectedRedirect(
  aiAgentId: string,
  provider: "google_calendar" | "calendly" = "google_calendar",
  flow?: string,
): string {
  // Return the user to where they STARTED. The origin travels in the signed
  // OAuth state (see the init routes); without this an onboarding connect
  // dropped the user on the marketplace page and onboarding looked reset.
  if (flow === "onboarding") {
    const base = process.env.FRONTEND_URL || process.env.DASHBOARD_URL || "";
    return `${base}/setup?connected=${provider}`;
  }
  const path = `/ai-studio/marketplace/${provider}?calendar=connected&aiAgentId=${aiAgentId}`;
  return process.env.DASHBOARD_URL ? `${process.env.DASHBOARD_URL}${path}` : path;
}

export default router;
