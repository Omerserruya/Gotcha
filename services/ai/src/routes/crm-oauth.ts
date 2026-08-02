/**
 * CRM OAuth routes - currently Zoho, extensible to Salesforce / HubSpot.
 *
 * Mounted at /api/integrations BEFORE the authenticated `integrationRoutes`
 * router, so the public /callback path is not caught by the admin auth gate.
 *
 *   GET /oauth/zoho_crm/init      (ADMIN) → signs JWT state, returns auth URL
 *   GET /oauth/zoho_crm/callback  (public) → verifies state, exchanges code,
 *                                        upserts TenantIntegration(CONNECTED),
 *                                        creates default TenantTool rows,
 *                                        302-redirects to the frontend.
 *
 * State JWT carries {tenantId, integrationSlug, userId} and is the only
 * trust anchor on the callback - so the callback is safe to leave public.
 */
import { Router, Request, Response } from "express";
import { prisma, authenticate, resolveTenant, requireOnboardingOrActiveTenant, requireRole, mintOAuthState, consumeOAuthState,
  resolveAppPublicUrl,
} from "@chatcenter/shared";
import {
  exchangeZohoCode,
  getZohoAccountsUrl,
  ZOHO_DEFAULT_SCOPES,
} from "../services/zoho.service";

const router = Router();


// ─── Zoho CRM OAuth ─────────────────────────────────────────

router.get(
  "/oauth/zoho_crm/init",
  authenticate,
  resolveTenant,
  requireOnboardingOrActiveTenant(),
  requireRole("ADMIN"),
  (req: Request, res: Response) => {
    const clientId = process.env.ZOHO_CLIENT_ID;
    const redirectUri = process.env.ZOHO_REDIRECT_URI;
    if (!clientId || !redirectUri) {
      res.status(500).json({ error: "Zoho OAuth not configured (set ZOHO_CLIENT_ID + ZOHO_REDIRECT_URI)" });
      return;
    }

    const flow = req.query.flow === "onboarding" ? "onboarding" : undefined;
    // Single-use state. `integrationSlug` is kept alongside `provider` because
    // the callback uses it to look up the catalog row.
    const { state } = mintOAuthState({
      tenantId: req.tenantId!, provider: "zoho_crm", integrationSlug: "zoho_crm",
      userId: (req as any).userId, flow,
    });

    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      scope: ZOHO_DEFAULT_SCOPES,
      redirect_uri: redirectUri,
      access_type: "offline",
      prompt: "consent",
      state,
    });

    const authUrl = `${getZohoAccountsUrl()}/oauth/v2/auth?${params.toString()}`;
    res.json({ url: authUrl });
  },
);

router.get("/oauth/zoho_crm/callback", async (req: Request, res: Response) => {
  const frontendUrl = resolveAppPublicUrl(process.env);
  try {
    const { code, state, error: zohoError } = req.query;

    if (zohoError) {
      res.redirect(`${frontendUrl}/integrations?error=${encodeURIComponent(String(zohoError))}`);
      return;
    }
    if (!code || !state) {
      res.status(400).json({ error: "Missing code or state" });
      return;
    }

    const consumed = await consumeOAuthState<{ tenantId: string; integrationSlug: string; userId?: string; flow?: string }>(
      state as string, "zoho_crm",
    );
    if (!consumed.ok) {
      console.warn(`[zoho_crm oauth] state rejected: ${consumed.reason}`);
      res.status(400).json({ error: consumed.reason === "replayed" ? "State already used" : "Invalid or expired state" });
      return;
    }
    const payload = consumed.claims;

    const redirectUri = process.env.ZOHO_REDIRECT_URI!;
    const tokens = await exchangeZohoCode({ code: String(code), redirectUri });

    // Find the Zoho catalog entry (+ default tools) to upsert the tenant link.
    const catalog = await prisma.integrationCatalog.findUnique({
      where: { slug: payload.integrationSlug },
      include: { catalogTools: { where: { isDefault: true } } },
    });
    if (!catalog) {
      console.error("[Zoho OAuth] Catalog entry not found:", payload.integrationSlug);
      res.redirect(`${frontendUrl}/integrations?error=catalog_missing`);
      return;
    }

    const credentialsPayload = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      scope: tokens.scope,
    };

    // api_domain is per-user (region-specific) - persist on config.baseUrl so
    // tool-execution.service.ts can prefix relative endpoints correctly.
    const configPayload = {
      baseUrl: (tokens.api_domain || "https://www.zohoapis.com").replace(/\/$/, ""),
      authScheme: "Zoho-oauthtoken",
      tokenRefreshUrl: `${getZohoAccountsUrl()}/oauth/v2/token`,
    };

    // Upsert TenantIntegration. On first connect we also auto-create
    // TenantTool rows for every default catalog tool (mirroring the
    // POST /:slug/connect path in integrations.ts).
    const existing = await prisma.tenantIntegration.findFirst({
      where: { tenantId: payload.tenantId, integrationId: catalog.id },
      select: { id: true },
    });

    let tenantIntegrationId: string;
    if (existing) {
      await prisma.tenantIntegration.update({
        where: { id: existing.id },
        data: {
          status: "CONNECTED",
          credentials: credentialsPayload as any,
          config: configPayload as any,
          connectedBy: payload.userId ?? null,
          connectedAt: new Date(),
          lastTestedAt: new Date(),
          lastTestResult: true,
          lastError: null,
        },
      });
      tenantIntegrationId = existing.id;
    } else {
      const created = await prisma.tenantIntegration.create({
        data: {
          tenantId: payload.tenantId,
          integrationId: catalog.id,
          status: "CONNECTED",
          credentials: credentialsPayload as any,
          config: configPayload as any,
          connectedBy: payload.userId ?? null,
          connectedAt: new Date(),
          lastTestedAt: new Date(),
          lastTestResult: true,
          tenantTools: {
            create: catalog.catalogTools.map((tool) => ({
              tenantId: payload.tenantId,
              catalogToolId: tool.id,
              isEnabled: true,
            })),
          },
        },
        select: { id: true },
      });
      tenantIntegrationId = created.id;
    }

    // Backfill TenantTool rows for any default tool that wasn't present
    // (e.g. re-connecting after a partial disconnect).
    const existingTools = await prisma.tenantTool.findMany({
      where: { tenantId: payload.tenantId, tenantIntegrationId },
      select: { catalogToolId: true },
    });
    const have = new Set(existingTools.map((t) => t.catalogToolId));
    const missing = catalog.catalogTools.filter((t) => !have.has(t.id));
    if (missing.length > 0) {
      await prisma.tenantTool.createMany({
        data: missing.map((tool) => ({
          tenantId: payload.tenantId,
          tenantIntegrationId,
          catalogToolId: tool.id,
          isEnabled: true,
        })),
      });
    }

    // During onboarding, return to /setup so the boot logic detects the
    // connected core system and finishes activation; otherwise integrations.
    res.redirect(
      payload.flow === "onboarding"
        ? `${frontendUrl}/setup?connected=${payload.integrationSlug}`
        : `${frontendUrl}/integrations?connected=${payload.integrationSlug}`,
    );
  } catch (err: any) {
    console.error("[Zoho OAuth] Callback error:", err?.message ?? err);
    res.redirect(`${frontendUrl}/integrations?error=oauth_callback_failed`);
  }
});

export default router;
