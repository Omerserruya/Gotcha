import { Router, Request, Response } from "express";
import { prisma, authenticate, resolveTenant, requireActiveTenant, requireOnboardingOrActiveTenant, requireRole, mintOAuthState, consumeOAuthState } from "@chatcenter/shared";
import * as confluenceService from "../services/confluence.service";
import * as googleDriveService from "../services/google-drive.service";

const router = Router();


// ─── Confluence OAuth ───────────────────────────────────────

router.get("/oauth/confluence/init", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), (req: Request, res: Response) => {
  const clientId = process.env.CONFLUENCE_CLIENT_ID;
  const redirectUri = process.env.CONFLUENCE_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    res.status(500).json({ error: "Confluence OAuth not configured" });
    return;
  }

  const kbId = req.query.kbId as string;
  if (!kbId) { res.status(400).json({ error: "kbId is required" }); return; }

  // Single-use state (shared store): the jti is burned on callback so a
  // captured state cannot be replayed within its TTL.
  const { state } = mintOAuthState({ tenantId: req.tenantId!, provider: "confluence", kbId, userId: (req as any).userId });

  const scopes = "read:confluence-content.all read:confluence-space.summary offline_access";
  const authUrl = `https://auth.atlassian.com/authorize?audience=api.atlassian.com&client_id=${clientId}&scope=${encodeURIComponent(scopes)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&response_type=code&prompt=consent`;

  res.json({ url: authUrl });
});

router.get("/oauth/confluence/callback", async (req: Request, res: Response) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) { res.status(400).json({ error: "Missing code or state" }); return; }

    const consumed = await consumeOAuthState<{ tenantId: string; kbId: string }>(state as string, "confluence");
    if (!consumed.ok) {
      console.warn(`[confluence oauth] state rejected: ${consumed.reason}`);
      res.status(400).json({ error: consumed.reason === "replayed" ? "state already used" : "invalid state" });
      return;
    }
    const { tenantId, kbId } = consumed.claims;

    const clientId = process.env.CONFLUENCE_CLIENT_ID!;
    const clientSecret = process.env.CONFLUENCE_CLIENT_SECRET!;
    const redirectUri = process.env.CONFLUENCE_REDIRECT_URI!;

    // Exchange code for tokens
    const tokenRes = await fetch("https://auth.atlassian.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.error("[Confluence OAuth] Token exchange failed:", err);
      res.status(400).json({ error: "Token exchange failed" });
      return;
    }

    const tokens: any = await tokenRes.json();

    // Get accessible resources (cloudId)
    const resourcesRes = await fetch("https://api.atlassian.com/oauth/token/accessible-resources", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const resources: any[] = await resourcesRes.json() as any[];
    if (!resources.length) {
      res.status(400).json({ error: "No accessible Confluence sites found" });
      return;
    }

    const site = resources[0];

    await (prisma as any).knowledgeIntegration.create({
      data: {
        tenantId,
        knowledgeBaseId: kbId,
        provider: "confluence",
        credentials: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          cloudId: site.id,
          expiresAt: Date.now() + tokens.expires_in * 1000,
        },
        displayName: site.name || "Confluence",
        config: {},
      },
    });

    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    res.redirect(`${frontendUrl}/knowledge?connected=confluence`);
  } catch (err: any) {
    console.error("[Confluence OAuth] Callback error:", err.message);
    res.status(500).json({ error: "OAuth callback failed" });
  }
});

// ─── Google Drive OAuth ─────────────────────────────────────

// PENDING_ONBOARDING allowed: onboarding Movement 6 connects Drive before the
// tenant flips ACTIVE. `flow=onboarding` rides the state so the callback can
// land back on /setup instead of the app's knowledge page.
router.get("/oauth/google-drive/init", authenticate, resolveTenant, requireOnboardingOrActiveTenant(), requireRole("ADMIN"), (req: Request, res: Response) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    res.status(500).json({ error: "Google Drive OAuth not configured" });
    return;
  }

  const kbId = req.query.kbId as string;
  if (!kbId) { res.status(400).json({ error: "kbId is required" }); return; }

  const { state } = mintOAuthState({
    tenantId: req.tenantId!, provider: "google_drive", kbId, userId: (req as any).userId,
    flow: req.query.flow === "onboarding" ? "onboarding" : undefined,
  });

  const scopes = "https://www.googleapis.com/auth/drive.readonly";
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scopes)}&state=${state}&access_type=offline&prompt=consent`;

  res.json({ url: authUrl });
});

router.get("/oauth/google-drive/callback", async (req: Request, res: Response) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) { res.status(400).json({ error: "Missing code or state" }); return; }

    const consumed = await consumeOAuthState<{ tenantId: string; kbId: string; flow?: string }>(state as string, "google_drive");
    if (!consumed.ok) {
      console.warn(`[google_drive oauth] state rejected: ${consumed.reason}`);
      res.status(400).json({ error: consumed.reason === "replayed" ? "state already used" : "invalid state" });
      return;
    }
    const payload = consumed.claims;
    const { tenantId, kbId } = payload;

    const clientId = process.env.GOOGLE_CLIENT_ID!;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI!;

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        code: code as string,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.error("[Google Drive OAuth] Token exchange failed:", err);
      res.status(400).json({ error: "Token exchange failed" });
      return;
    }

    const tokens: any = await tokenRes.json();

    // Get user info for display name
    const userRes = await fetch("https://www.googleapis.com/drive/v3/about?fields=user", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const userInfo: any = userRes.ok ? await userRes.json() : null;

    await prisma.knowledgeIntegration.create({
      data: {
        tenantId,
        knowledgeBaseId: kbId,
        provider: "google_drive",
        credentials: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: Date.now() + tokens.expires_in * 1000,
        },
        displayName: userInfo?.user?.displayName || "Google Drive",
        config: {},
      },
    });

    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    // Onboarding-initiated connects return to the wizard (Movement 6 resumes
    // via the persisted progress checkpoint); everything else to the app.
    res.redirect(payload.flow === "onboarding" ? `${frontendUrl}/setup?connected=google_drive` : `${frontendUrl}/knowledge?connected=google_drive`);
  } catch (err: any) {
    console.error("[Google Drive OAuth] Callback error:", err.message);
    res.status(500).json({ error: "OAuth callback failed" });
  }
});

// ─── Integration API Routes (authenticated) ──────────────────

// PENDING_ONBOARDING allowed so the onboarding wizard can list the Drive
// integration, browse files, and trigger the first sync (admin-only, tenant-scoped).
router.use(authenticate, resolveTenant, requireOnboardingOrActiveTenant(), requireRole("ADMIN"));

// List integrations for a knowledge base
router.get("/kb/:kbId/integrations", async (req: Request, res: Response) => {
  try {
    const kb = await prisma.knowledgeBase.findFirst({
      where: { id: String(req.params.kbId), tenantId: req.tenantId! },
    });
    if (!kb) { res.status(404).json({ error: "Knowledge base not found" }); return; }

    const integrations = await prisma.knowledgeIntegration.findMany({
      where: { knowledgeBaseId: kb.id, tenantId: req.tenantId! },
      select: {
        id: true,
        provider: true,
        displayName: true,
        config: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ data: integrations });
  } catch (err) {
    console.error("List integrations error:", err);
    res.status(500).json({ error: "Failed to list integrations" });
  }
});

// Delete (disconnect) integration
router.delete("/integrations/:intId", async (req: Request, res: Response) => {
  try {
    const integration = await prisma.knowledgeIntegration.findFirst({
      where: { id: String(req.params.intId), tenantId: req.tenantId! },
    });
    if (!integration) { res.status(404).json({ error: "Integration not found" }); return; }

    await prisma.knowledgeIntegration.delete({ where: { id: integration.id } });
    res.json({ data: { deleted: true } });
  } catch (err) {
    console.error("Delete integration error:", err);
    res.status(500).json({ error: "Failed to delete integration" });
  }
});

// ─── Confluence: list spaces ─────────────────────────────────

router.get("/integrations/:intId/confluence/spaces", async (req: Request, res: Response) => {
  try {
    const integration = await prisma.knowledgeIntegration.findFirst({
      where: { id: String(req.params.intId), tenantId: req.tenantId!, provider: "confluence" },
    });
    if (!integration) { res.status(404).json({ error: "Integration not found" }); return; }

    const spaces = await confluenceService.listSpaces(integration as any);
    res.json({ data: spaces });
  } catch (err: any) {
    console.error("List Confluence spaces error:", err.message);
    res.status(500).json({ error: "Failed to list spaces" });
  }
});

// ─── Confluence: list pages in space ─────────────────────────

router.get("/integrations/:intId/confluence/spaces/:key/pages", async (req: Request, res: Response) => {
  try {
    const integration = await prisma.knowledgeIntegration.findFirst({
      where: { id: String(req.params.intId), tenantId: req.tenantId!, provider: "confluence" },
    });
    if (!integration) { res.status(404).json({ error: "Integration not found" }); return; }

    const parentId = req.query.parentId as string | undefined;
    const pages = await confluenceService.listPages(integration as any, String(req.params.key), parentId);
    res.json({ data: pages });
  } catch (err: any) {
    console.error("List Confluence pages error:", err.message);
    res.status(500).json({ error: "Failed to list pages" });
  }
});

// ─── Confluence: sync spaces ─────────────────────────────────

router.post("/integrations/:intId/confluence/sync", async (req: Request, res: Response) => {
  try {
    const integration = await prisma.knowledgeIntegration.findFirst({
      where: { id: String(req.params.intId), tenantId: req.tenantId!, provider: "confluence" },
    });
    if (!integration) { res.status(404).json({ error: "Integration not found" }); return; }

    const { spaceKeys } = req.body;
    if (!spaceKeys?.length) { res.status(400).json({ error: "spaceKeys required" }); return; }

    // Remember the selected spaces + turn on auto-sync so the hourly scheduler
    // knows what to refresh. Mutate the in-memory config too, so syncSpace's own
    // config write (lastSyncAt) preserves these keys instead of dropping them.
    const cfg = (integration.config && typeof integration.config === "object" ? integration.config : {}) as Record<string, unknown>;
    const newConfig = { ...cfg, spaceKeys, autoSync: cfg.autoSync ?? true };
    await prisma.knowledgeIntegration.update({ where: { id: integration.id }, data: { config: newConfig } });
    (integration as any).config = newConfig;

    let totalImported = 0, totalUpdated = 0, totalSkipped = 0;
    for (const key of spaceKeys) {
      const result = await confluenceService.syncSpace(integration as any, key);
      totalImported += result.imported; totalUpdated += result.updated; totalSkipped += result.skipped;
    }

    res.json({ data: { imported: totalImported, updated: totalUpdated, skipped: totalSkipped } });
  } catch (err: any) {
    console.error("Confluence sync error:", err.message);
    res.status(500).json({ error: "Failed to sync" });
  }
});

// ─── Google Drive: list shared drives ────────────────────────

router.get("/integrations/:intId/drive/shared-drives", async (req: Request, res: Response) => {
  try {
    const integration = await prisma.knowledgeIntegration.findFirst({
      where: { id: String(req.params.intId), tenantId: req.tenantId!, provider: "google_drive" },
    });
    if (!integration) { res.status(404).json({ error: "Integration not found" }); return; }

    const drives = await googleDriveService.listSharedDrives(integration as any);
    res.json({ data: drives });
  } catch (err: any) {
    console.error("List shared drives error:", err.message);
    res.status(500).json({ error: "Failed to list shared drives" });
  }
});

// ─── Google Drive: list files ─────────────────────────────────

router.get("/integrations/:intId/drive/files", async (req: Request, res: Response) => {
  try {
    const integration = await prisma.knowledgeIntegration.findFirst({
      where: { id: String(req.params.intId), tenantId: req.tenantId!, provider: "google_drive" },
    });
    if (!integration) { res.status(404).json({ error: "Integration not found" }); return; }

    const folderId = req.query.folderId as string | undefined;
    const driveId = req.query.driveId as string | undefined;
    const files = await googleDriveService.listFiles(integration as any, folderId, driveId);
    res.json({ data: files });
  } catch (err: any) {
    console.error("List Drive files error:", err.message);
    res.status(500).json({ error: "Failed to list files" });
  }
});

// ─── Google Drive: sync files ─────────────────────────────────

router.post("/integrations/:intId/drive/sync", async (req: Request, res: Response) => {
  try {
    const integration = await prisma.knowledgeIntegration.findFirst({
      where: { id: String(req.params.intId), tenantId: req.tenantId!, provider: "google_drive" },
    });
    if (!integration) { res.status(404).json({ error: "Integration not found" }); return; }

    const { fileIds } = req.body;
    if (!fileIds?.length) { res.status(400).json({ error: "fileIds required" }); return; }

    // Remember the selected files + turn on auto-sync (see Confluence note above).
    const cfg = (integration.config && typeof integration.config === "object" ? integration.config : {}) as Record<string, unknown>;
    const newConfig = { ...cfg, fileIds, autoSync: cfg.autoSync ?? true };
    await prisma.knowledgeIntegration.update({ where: { id: integration.id }, data: { config: newConfig } });
    (integration as any).config = newConfig;

    const result = await googleDriveService.syncFiles(integration as any, fileIds);
    res.json({ data: result });
  } catch (err: any) {
    console.error("Drive sync error:", err.message);
    res.status(500).json({ error: "Failed to sync" });
  }
});

// ─── Auto-sync toggle ─────────────────────────────────────────
// Enable/disable the hourly background re-sync for one integration. Stored on
// config.autoSync; the scheduler only refreshes integrations where it's not
// explicitly false and that have a persisted selection (spaceKeys / fileIds).
router.patch("/integrations/:intId/auto-sync", async (req: Request, res: Response) => {
  try {
    const integration = await prisma.knowledgeIntegration.findFirst({
      where: { id: String(req.params.intId), tenantId: req.tenantId! },
    });
    if (!integration) { res.status(404).json({ error: "Integration not found" }); return; }

    const enabled = req.body?.enabled !== false; // default ON
    const cfg = (integration.config && typeof integration.config === "object" ? integration.config : {}) as Record<string, unknown>;
    await prisma.knowledgeIntegration.update({
      where: { id: integration.id },
      data: { config: { ...cfg, autoSync: enabled } },
    });
    res.json({ data: { autoSync: enabled } });
  } catch (err: any) {
    console.error("Auto-sync toggle error:", err.message);
    res.status(500).json({ error: "Failed to update auto-sync" });
  }
});

export default router;
