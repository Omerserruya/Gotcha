import crypto from "crypto";
import { Router, Request, Response } from "express";
import { z } from "zod";
import axios from "axios";
import jwt from "jsonwebtoken";
import {
  prisma,
  authenticate,
  resolveTenant,
  requireRole,
  requirePermissionOrRole,
  validate,
  getRedis,
  encryptCredentials,
  decryptCredentials,
  mintOAuthState,
  consumeOAuthState,
  resolvePrincipal,
} from "@chatcenter/shared";

const router = Router();

const META_APP_ID = process.env.META_APP_ID || "";
const META_APP_SECRET = process.env.META_APP_SECRET || "";
const EMBEDDED_SIGNUP_CONFIG_ID = process.env.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID || "";
const OAUTH_REDIRECT_URI = process.env.OAUTH_REDIRECT_URI || "";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";
const FB_API_URL = process.env.FACEBOOK_API_URL || "https://graph.facebook.com/v21.0";
// OAuth `state` signing only - not user auth. See getOAuthStateSecret().

// Instagram API with Instagram Login (direct IG Business connect - no Facebook Page).
// These are the *Instagram* app credentials from the Meta App Dashboard
// ("Instagram API setup with Instagram login"), which differ from META_APP_ID/SECRET.
// INSTAGRAM_OAUTH_REDIRECT_URI must be registered under that product; falls back to
// the shared OAuth callback when unset.
// Falls back to the Meta app credentials - when Instagram Login is added to the
// SAME Meta app, the dashboard shows the same app id/secret, so no duplication needed.
const INSTAGRAM_APP_ID = process.env.INSTAGRAM_APP_ID || META_APP_ID;
const INSTAGRAM_APP_SECRET = process.env.INSTAGRAM_APP_SECRET || META_APP_SECRET;
const INSTAGRAM_OAUTH_REDIRECT_URI = process.env.INSTAGRAM_OAUTH_REDIRECT_URI || OAUTH_REDIRECT_URI;
// graph.instagram.com (Instagram Login) does NOT accept a version-prefixed path
// for these edges (/me, /access_token, /me/subscribed_apps) - a versioned path is
// treated as an unknown node and returns "Unsupported request". Must be unversioned.
const IG_API_URL = process.env.INSTAGRAM_API_URL || "https://graph.instagram.com";

// Google (Gmail) OAuth
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_OAUTH_REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI || "";

// Microsoft (Outlook) OAuth
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID || "";
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET || "";
const MICROSOFT_OAUTH_REDIRECT_URI = process.env.MICROSOFT_OAUTH_REDIRECT_URI || "";
const MICROSOFT_TENANT_ID = process.env.MICROSOFT_TENANT_ID || "common";

// Slack OAuth
const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID || "";
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET || "";
const SLACK_OAUTH_REDIRECT_URI = process.env.SLACK_OAUTH_REDIRECT_URI || "";
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || "";

// ─── Auto-create router rule for email channels ─────────────
async function ensureEmailRouterRule(tenantId: string, channel: "GMAIL" | "OUTLOOK", displayName: string) {
  try {
    // Check if a router rule with a channel condition for this email type already exists
    const existingRules = await prisma.routerRule.findMany({
      where: { tenantId },
      orderBy: { position: "asc" },
    });
    const hasChannelRule = existingRules.some((r) => {
      const conditions = (r.conditions as any[]) || [];
      return conditions.some((c: any) => c.type === "channel" && c.value?.toUpperCase() === channel);
    });
    if (hasChannelRule) return;

    // Email rules go first - shift all existing rules down by 1
    await prisma.$transaction(
      existingRules.map((r) =>
        prisma.routerRule.update({
          where: { id: r.id },
          data: { position: r.position + 1 },
        })
      )
    );

    await prisma.routerRule.create({
      data: {
        tenantId,
        name: `${channel === "GMAIL" ? "Gmail" : "Outlook"} - ${displayName}`,
        position: 1,
        conditions: [{ type: "channel", operator: "equals", value: channel.toLowerCase() }],
        logic: "AND",
        routeType: "HUMAN",
        enabled: true,
        isDefault: false,
      },
    });

    // Auto-create default fallback rule if none exists
    const hasDefault = existingRules.some((r) => r.isDefault);
    if (!hasDefault) {
      await prisma.routerRule.create({
        data: {
          tenantId,
          name: "Default Fallback",
          position: existingRules.length + 2,
          conditions: [],
          logic: "AND",
          routeType: "HUMAN",
          enabled: true,
          isDefault: true,
        },
      });
    }
    console.log(`[CHANNELS] Auto-created router rule for ${channel} channel (${displayName})`);
  } catch (err) {
    console.warn(`[CHANNELS] Failed to auto-create router rule for ${channel}:`, err);
  }
}

// ─── List Connected Channels ─────────────────────────────────

router.get("/", authenticate, resolveTenant, requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const accounts = await prisma.channelAccount.findMany({
      where: { tenantId: req.tenantId! },
      select: {
        id: true,
        channel: true,
        externalId: true,
        displayName: true,
        isActive: true,
        connectionStatus: true,
        connectedAt: true,
        tokenExpiresAt: true,
        lastError: true,
        lastHealthCheck: true,
        platformMeta: true,
        createdAt: true,
        updatedAt: true,
        responseMode: true,
        _count: { select: { conversations: { where: { status: { not: "CLOSED" } } } } },
      },
      orderBy: { createdAt: "asc" },
    });
    res.json({ data: accounts });
  } catch (err) {
    console.error("List channels error:", err);
    res.status(500).json({ error: "Failed to list channels" });
  }
});

// ─── Channel-connectivity summary (all roles) ─────────────────────────────
// The Inbox/History empty states need to know WHY a list is empty ("no
// channel connected" vs "channel broken" vs "no conversations yet"), and
// agents see those pages too - the full listing above is ADMIN-only. This
// returns health COUNTS only: no tokens, external ids, or error details.
router.get("/summary", authenticate, resolveTenant, async (req: Request, res: Response) => {
  try {
    const rows = await prisma.channelAccount.findMany({
      where: { tenantId: req.tenantId! },
      select: { connectionStatus: true, isActive: true },
    });
    const connected = rows.filter((r) => r.connectionStatus === "CONNECTED" && r.isActive).length;
    const unhealthy = rows.filter((r) => r.connectionStatus === "ERROR" || r.connectionStatus === "DISCONNECTED").length;
    const pending = rows.filter((r) => r.connectionStatus === "PENDING").length;
    res.json({ data: { total: rows.length, connected, unhealthy, pending } });
  } catch (err) {
    console.error("Channel summary error:", err);
    res.status(500).json({ error: "Failed to get channel summary" });
  }
});

// ─── List recent posts for a connected page (Comment Trigger picker) ─────
//
// Returns a normalized list of the page's own posts so flow authors can
// select which post a Comment Trigger should listen on, instead of pasting
// raw IDs. Group posts intentionally NOT supported - the Meta Groups API
// was deprecated April 2024; for those, the trigger UI exposes a manual
// post-URL paste field that the runtime later matches via the page webhook.
//
// Supports MESSENGER (Facebook page) and INSTAGRAM (IG Business account).
router.get("/:id/posts", authenticate, resolveTenant, requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const channelId = String(req.params.id);
    const account = await prisma.channelAccount.findFirst({
      where: { id: channelId, tenantId: req.tenantId! },
      select: { channel: true, externalId: true, credentials: true, platformMeta: true },
    });
    if (!account) return res.status(404).json({ error: "Channel not found" });
    if (account.channel !== "MESSENGER" && account.channel !== "INSTAGRAM") {
      return res.status(400).json({ error: "Posts are only available for Facebook and Instagram channels" });
    }
    const creds = (typeof account.credentials === "string"
      ? decryptCredentials(account.credentials as string)
      : (account.credentials as any)) || {};
    const accessToken = creds.accessToken;
    if (!accessToken) return res.status(400).json({ error: "Channel is missing an access token" });

    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));

    if (account.channel === "MESSENGER") {
      const pageId = creds.pageId || account.externalId;
      const url = `${FB_API_URL}/${pageId}/posts`;
      const resp = await axios.get(url, {
        params: {
          fields: "id,message,full_picture,permalink_url,created_time",
          limit,
          access_token: accessToken,
        },
        timeout: 10_000,
      });
      const items = (resp.data?.data || []).map((p: any) => ({
        id: p.id,
        caption: p.message || "",
        thumbnailUrl: p.full_picture || null,
        permalink: p.permalink_url || null,
        createdAt: p.created_time || null,
        source: "page" as const,
      }));
      return res.json({ data: items });
    }

    // Instagram
    const igUserId = creds.igBusinessId || account.externalId;
    const url = `${FB_API_URL}/${igUserId}/media`;
    const resp = await axios.get(url, {
      params: {
        fields: "id,caption,media_url,thumbnail_url,permalink,timestamp,media_type",
        limit,
        access_token: accessToken,
      },
      timeout: 10_000,
    });
    const items = (resp.data?.data || []).map((m: any) => ({
      id: m.id,
      caption: m.caption || "",
      // VIDEO posts use thumbnail_url; IMAGE posts use media_url.
      thumbnailUrl: m.media_type === "VIDEO" ? (m.thumbnail_url || m.media_url || null) : (m.media_url || null),
      permalink: m.permalink || null,
      createdAt: m.timestamp || null,
      source: "page" as const,
    }));
    return res.json({ data: items });
  } catch (err: any) {
    const detail = err?.response?.data?.error?.message || err?.message;
    console.error(`[channels] GET /${String(req.params.id)}/posts failed:`, detail);
    return res.status(502).json({ error: "Failed to load posts", detail });
  }
});

// ─── WhatsApp Embedded Signup Connect ────────────────────────

const whatsappConnectSchema = z.object({
  code: z.string().min(1),
  wabaId: z.string().optional(),       // From Embedded Signup session info
  phoneNumberId: z.string().optional(), // From Embedded Signup session info
});

router.post("/connect/whatsapp", authenticate, resolveTenant, requireRole("ADMIN"), validate(whatsappConnectSchema), async (req: Request, res: Response) => {
  try {
    const { code, wabaId: sessionWabaId, phoneNumberId: sessionPhoneNumberId } = req.body;
    console.log("[WA-CONNECT] Starting. Session WABA:", sessionWabaId, "Session Phone:", sessionPhoneNumberId);

    // Step 1: Exchange code for business token
    // Per Meta Tech Provider docs: GET /oauth/access_token with client_id, client_secret, code
    // FB.login popup may require redirect_uri matching, so try multiple approaches
    let accessToken: string | undefined;

    // Try exchanging the popup code with various redirect_uri values and API versions
    const v25 = "https://graph.facebook.com/v25.0";
    const exchangeAttempts: Array<{ label: string; method: "get" | "post"; url: string; data: any }> = [
      // Official docs method: GET, no redirect_uri
      { label: "GET no redirect_uri", method: "get", url: `${FB_API_URL}/oauth/access_token`, data: { client_id: META_APP_ID, client_secret: META_APP_SECRET, code } },
      // Same but v25.0 (SDK uses v25.0)
      { label: "GET no redirect_uri v25", method: "get", url: `${v25}/oauth/access_token`, data: { client_id: META_APP_ID, client_secret: META_APP_SECRET, code } },
      // POST no redirect_uri
      { label: "POST no redirect_uri", method: "post", url: `${FB_API_URL}/oauth/access_token`, data: { client_id: META_APP_ID, client_secret: META_APP_SECRET, code } },
      // POST with grant_type
      { label: "POST grant_type v25", method: "post", url: `${v25}/oauth/access_token`, data: { client_id: META_APP_ID, client_secret: META_APP_SECRET, grant_type: "authorization_code", code } },
    ];

    for (const attempt of exchangeAttempts) {
      try {
        console.log(`[WA-CONNECT] Trying: ${attempt.label}`);
        let tokenResponse;
        if (attempt.method === "get") {
          tokenResponse = await axios.get(attempt.url, { params: attempt.data });
        } else {
          tokenResponse = await axios.post(attempt.url, attempt.data, {
            headers: { "Content-Type": "application/json" },
          });
        }
        const tokenData = tokenResponse.data;
        accessToken = typeof tokenData === "string" ? tokenData : tokenData.access_token;
        if (accessToken && typeof accessToken === "string" && accessToken.length > 10) {
          console.log(`[WA-CONNECT] Business token obtained with: ${attempt.label}`);
          break;
        }
        accessToken = undefined;
      } catch (err: any) {
        console.warn(`[WA-CONNECT] Failed ${attempt.label}:`, err.response?.data?.error?.message);
      }
    }

    if (!accessToken) {
      res.status(400).json({ error: "Failed to exchange code for business token. Check Facebook App redirect_uri settings." });
      return;
    }

    // Determine WABA ID: prefer session info from Embedded Signup, fall back to debug_token
    let wabaId = sessionWabaId;
    let phoneNumberIds: string[] = sessionPhoneNumberId ? [sessionPhoneNumberId] : [];

    if (!wabaId) {
      // Fallback: debug_token to discover WABA IDs from granular_scopes
      console.log("[WA-CONNECT] No session WABA ID, trying debug_token...");
      try {
        const debugResponse = await axios.get(`${FB_API_URL}/debug_token`, {
          params: { input_token: accessToken },
          headers: { Authorization: `Bearer ${META_APP_ID}|${META_APP_SECRET}` },
        });
        console.log("[WA-CONNECT] debug_token:", JSON.stringify(debugResponse.data?.data?.granular_scopes, null, 2));
        const granularScopes = debugResponse.data?.data?.granular_scopes || [];
        const wabaScope = granularScopes.find((s: any) => s.scope === "whatsapp_business_management");
        const wabaIds = wabaScope?.target_ids || [];
        if (wabaIds.length > 0) wabaId = wabaIds[0];
      } catch (debugErr: any) {
        console.warn("[WA-CONNECT] debug_token failed:", debugErr.response?.data?.error?.message);
      }
    }

    if (!wabaId) {
      res.status(400).json({ error: "No WhatsApp Business Account found. Please complete the Embedded Signup flow." });
      return;
    }

    // Step 2: Subscribe app to webhooks on customer's WABA. This is what
    // makes inbound messages actually arrive - if it fails, the channel is
    // NOT usable and must not be presented as CONNECTED.
    console.log("[WA-CONNECT] Subscribing app to WABA webhooks:", wabaId);
    let webhookSubscribed = false;
    let webhookError: string | null = null;
    try {
      await axios.post(
        `${FB_API_URL}/${wabaId}/subscribed_apps`,
        {},
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      webhookSubscribed = true;
    } catch (subErr: any) {
      webhookError = subErr.response?.data?.error?.message || subErr.message || "webhook subscription failed";
      console.warn(`[WA-CONNECT] Webhook subscription FAILED for WABA ${wabaId}:`, webhookError);
    }

    // If we don't have phone number IDs from session info, fetch them from the WABA
    if (phoneNumberIds.length === 0) {
      console.log("[WA-CONNECT] Fetching phone numbers for WABA:", wabaId);
      const phonesResponse = await axios.get(`${FB_API_URL}/${wabaId}/phone_numbers`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      phoneNumberIds = (phonesResponse.data?.data || []).map((p: any) => p.id);
    }

    if (phoneNumberIds.length === 0) {
      res.status(400).json({ error: "No phone numbers found in the WhatsApp Business Account." });
      return;
    }

    const connectedAccounts: any[] = [];
    const redis = getRedis();

    for (const phoneNumberId of phoneNumberIds) {
      // Get phone number details
      let phoneDetails: any = { id: phoneNumberId };
      try {
        const phoneResponse = await axios.get(`${FB_API_URL}/${phoneNumberId}`, {
          params: { fields: "id,display_phone_number,verified_name,quality_rating" },
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        phoneDetails = phoneResponse.data;
      } catch (err: any) {
        console.warn(`[WA-CONNECT] Failed to get details for phone ${phoneNumberId}:`, err.response?.data?.error?.message);
      }

      const displayPhone = phoneDetails.display_phone_number || phoneDetails.verified_name || phoneNumberId;

      // Step 3: Register customer's phone number
      try {
        await axios.post(
          `${FB_API_URL}/${phoneNumberId}/register`,
          { messaging_product: "whatsapp", pin: "000000" },
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        console.log(`[WA-CONNECT] Registered phone ${phoneNumberId}`);
      } catch (regErr: any) {
        // Phone may already be registered - that's OK
        console.warn(`[WA-CONNECT] Phone registration note for ${phoneNumberId}:`, regErr.response?.data?.error?.message);
      }

      // Check if already connected. findUnique on the (channel, externalId)
      // compound unique index - TenantGuard exempts single-row lookups by
      // unique key, so this works whether the row belongs to us or another
      // tenant; we still gate on existing.tenantId before mutating.
      const existing = await prisma.channelAccount.findUnique({
        where: { channel_externalId: { channel: "WHATSAPP", externalId: phoneNumberId } },
      });

      if (existing && existing.tenantId !== req.tenantId!) {
        console.warn(`[WA-CONNECT] Phone ${phoneNumberId} already connected to another tenant`);
        continue;
      }

      const credentials = encryptCredentials({ accessToken, wabaId, phoneNumber: displayPhone });
      const tokenExpiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // Business tokens don't expire
      const honestStatus = webhookSubscribed ? ("CONNECTED" as const) : ("PENDING" as const);
      const honestError = webhookSubscribed ? null : `Webhook subscription failed - messages cannot arrive yet: ${webhookError}`;

      if (existing) {
        const updated = await prisma.channelAccount.update({
          where: { id: existing.id },
          data: {
            credentials,
            connectionStatus: honestStatus,
            connectedAt: new Date(),
            connectedBy: req.user?.userId,
            tokenExpiresAt,
            isActive: true,
            lastError: honestError,
            displayName: phoneDetails.verified_name || displayPhone,
            platformMeta: { wabaId, qualityRating: phoneDetails.quality_rating },
          },
        });
        connectedAccounts.push(updated);
      } else {
        const account = await prisma.channelAccount.create({
          data: {
            tenantId: req.tenantId!,
            channel: "WHATSAPP",
            externalId: phoneNumberId,
            displayName: phoneDetails.verified_name || displayPhone,
            credentials,
            connectionStatus: honestStatus,
            lastError: honestError,
            connectedAt: new Date(),
            connectedBy: req.user?.userId,
            tokenExpiresAt,
            isActive: true,
            platformMeta: { wabaId, qualityRating: phoneDetails.quality_rating },
          },
        });
        connectedAccounts.push(account);
      }

      await redis.del(`channel_account:WHATSAPP:${phoneNumberId}`);
    }

    if (connectedAccounts.length === 0) {
      res.status(400).json({ error: "Could not connect any phone numbers." });
      return;
    }

    console.log(`[WA-CONNECT] Persisted ${connectedAccounts.length} account(s), webhookSubscribed=${webhookSubscribed}`);
    res.status(201).json({ data: connectedAccounts, webhookSubscribed });
  } catch (err: any) {
    console.error("[WA-CONNECT] Error:", err.response?.data || err.message);
    const metaError = err.response?.data?.error;
    if (metaError) {
      res.status(400).json({ error: metaError.message || "Meta API error", code: metaError.code });
    } else {
      res.status(500).json({ error: "Failed to connect WhatsApp" });
    }
  }
});

// ─── WhatsApp Session Completion (from popup session info) ────

const whatsappSessionSchema = z.object({
  wabaId: z.string().min(1),
  phoneNumberId: z.string().optional(),
});

router.post("/connect/whatsapp-session", authenticate, resolveTenant, requireRole("ADMIN"), validate(whatsappSessionSchema), async (req: Request, res: Response) => {
  try {
    const { wabaId, phoneNumberId } = req.body;
    const redis = getRedis();

    // Retrieve pending token from Redis
    const accessToken = await redis.get(`wa_pending_token:${req.tenantId!}`);
    if (!accessToken) {
      res.status(400).json({ error: "No pending WhatsApp token. Please reconnect." });
      return;
    }
    await redis.del(`wa_pending_token:${req.tenantId!}`);

    console.log("[WA-SESSION] Completing setup with WABA:", wabaId, "Phone:", phoneNumberId);

    // Subscribe app to WABA webhooks
    try {
      await axios.post(`${FB_API_URL}/${wabaId}/subscribed_apps`, {}, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch (subErr: any) {
      console.warn("[WA-SESSION] Webhook subscription warning:", subErr.response?.data?.error?.message);
    }

    // Get phone numbers
    let phoneNumberIds: string[] = phoneNumberId ? [phoneNumberId] : [];
    if (phoneNumberIds.length === 0) {
      const phonesResponse = await axios.get(`${FB_API_URL}/${wabaId}/phone_numbers`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      phoneNumberIds = (phonesResponse.data?.data || []).map((p: any) => p.id);
    }

    const connectedAccounts: any[] = [];
    const tokenExpiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

    for (const pnId of phoneNumberIds) {
      let phoneDetails: any = { id: pnId };
      try {
        const resp = await axios.get(`${FB_API_URL}/${pnId}`, {
          params: { fields: "id,display_phone_number,verified_name,quality_rating" },
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        phoneDetails = resp.data;
      } catch {}

      const displayPhone = phoneDetails.display_phone_number || phoneDetails.verified_name || pnId;

      try {
        await axios.post(`${FB_API_URL}/${pnId}/register`,
          { messaging_product: "whatsapp", pin: "000000" },
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
      } catch {}

      // Unique-key lookup (see /connect/whatsapp).
      const existing = await prisma.channelAccount.findUnique({
        where: { channel_externalId: { channel: "WHATSAPP", externalId: pnId } },
      });
      if (existing && existing.tenantId !== req.tenantId!) continue;

      const credentials = encryptCredentials({ accessToken, wabaId, phoneNumber: displayPhone });

      if (existing) {
        const updated = await prisma.channelAccount.update({
          where: { id: existing.id },
          data: { credentials, connectionStatus: "CONNECTED", connectedAt: new Date(), connectedBy: req.user?.userId, tokenExpiresAt, isActive: true, lastError: null, displayName: phoneDetails.verified_name || displayPhone, platformMeta: { wabaId, qualityRating: phoneDetails.quality_rating } },
        });
        connectedAccounts.push(updated);
      } else {
        const account = await prisma.channelAccount.create({
          data: { tenantId: req.tenantId!, channel: "WHATSAPP", externalId: pnId, displayName: phoneDetails.verified_name || displayPhone, credentials, connectionStatus: "CONNECTED", connectedAt: new Date(), connectedBy: req.user?.userId, tokenExpiresAt, isActive: true, platformMeta: { wabaId, qualityRating: phoneDetails.quality_rating } },
        });
        connectedAccounts.push(account);
      }

      await redis.del(`channel_account:WHATSAPP:${pnId}`);
    }

    console.log(`[WA-SESSION] Connected ${connectedAccounts.length} account(s)`);
    res.status(201).json({ data: connectedAccounts });
  } catch (err: any) {
    console.error("[WA-SESSION] Error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to complete WhatsApp setup" });
  }
});

// ─── OAuth Init ──────────────────────────────────────────────

router.get("/oauth/init", async (req: Request, res: Response) => {
  // Special handling: accept token from query param since this is a redirect from frontend
  // The authenticate middleware reads from Bearer header, so we manually verify here
  const tokenParam = req.query.token as string;
  if (!tokenParam) {
    res.status(401).json({ error: "Missing token" });
    return;
  }

  // This is a redirect from the frontend, so the token arrives as a query
  // param instead of a Bearer header. Verify it the SAME way the rest of the
  // app does - resolvePrincipal checks the Authentik RS256 signature via JWKS
  // and resolves the local account - NOT jwt.verify() with the OAuth-state
  // HMAC secret, which cannot validate an RS256 token and 401'd every real
  // user after the Authentik migration.
  let principal;
  try {
    principal = await resolvePrincipal(tokenParam);
  } catch {
    res.status(401).json({ error: "Invalid token" });
    return;
  }

  // Inject tenant/user context like the authenticate middleware would.
  req.tenantId = principal.tenantId;
  (req as any).userId = principal.userId;

  if (principal.role !== "ADMIN") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }

  try {
    const platform = req.query.platform as string;
    if (!platform || !["messenger", "instagram", "whatsapp", "gmail", "outlook", "slack"].includes(platform)) {
      res.status(400).json({ error: "Invalid platform. Must be 'messenger', 'instagram', 'whatsapp', 'gmail', 'outlook', or 'slack'" });
      return;
    }

    // Validate platform-specific config
    if (["messenger", "whatsapp"].includes(platform) && (!META_APP_ID || !OAUTH_REDIRECT_URI)) {
      res.redirect(`${FRONTEND_URL}/settings/channels?error=not_configured&platform=messenger`);
      return;
    }
    if (platform === "instagram" && (!INSTAGRAM_APP_ID || !INSTAGRAM_OAUTH_REDIRECT_URI)) {
      res.redirect(`${FRONTEND_URL}/settings/channels?error=not_configured&platform=instagram`);
      return;
    }
    if (platform === "gmail" && (!GOOGLE_CLIENT_ID || !GOOGLE_OAUTH_REDIRECT_URI)) {
      res.redirect(`${FRONTEND_URL}/settings/channels?error=not_configured&platform=gmail`);
      return;
    }
    if (platform === "outlook" && (!MICROSOFT_CLIENT_ID || !MICROSOFT_OAUTH_REDIRECT_URI)) {
      res.redirect(`${FRONTEND_URL}/settings/channels?error=not_configured&platform=outlook`);
      return;
    }
    if (platform === "slack" && (!SLACK_CLIENT_ID || !SLACK_OAUTH_REDIRECT_URI)) {
      res.redirect(`${FRONTEND_URL}/settings/channels?error=not_configured&platform=slack`);
      return;
    }

    // Capture session info from popup (passed as query params for WhatsApp)
    const wabaId = req.query.wabaId as string || "";
    const phoneNumberId = req.query.phoneNumberId as string || "";

    // Generate signed state JWT (anti-CSRF + tenant context + session info)
    // Single-use state (shared store). `provider` is the constant
    // "meta_channels" because this ONE callback serves whatsapp / instagram /
    // messenger; the specific `platform` stays its own claim and is read from
    // the verified payload, never from the query string. The jti replaces the
    // old hand-rolled `nonce`, which was never checked against anything.
    const { state } = mintOAuthState({
      tenantId: req.tenantId!,
      provider: "meta_channels",
      userId: principal.userId,
      platform,
      wabaId,        // From Embedded Signup popup session info
      phoneNumberId, // From Embedded Signup popup session info
    });

    let oauthUrl: string;

    if (platform === "whatsapp") {
      // WhatsApp Embedded Signup: config_id + extras triggers the signup wizard
      const extras = encodeURIComponent(JSON.stringify({ setup: { channel: "WHATSAPP" } }));
      oauthUrl = `https://www.facebook.com/v25.0/dialog/oauth?client_id=${META_APP_ID}&config_id=${EMBEDDED_SIGNUP_CONFIG_ID}&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT_URI)}&state=${encodeURIComponent(state)}&response_type=code&override_default_response_type=true&extras=${extras}`;
    } else if (platform === "gmail") {
      // Google OAuth2 for Gmail API
      const googleScopes = [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.send",
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/userinfo.email",
      ].join(" ");
      oauthUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(GOOGLE_OAUTH_REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(googleScopes)}&access_type=offline&prompt=consent&state=${encodeURIComponent(state)}`;
    } else if (platform === "outlook") {
      // Microsoft OAuth2 for Outlook Mail (Microsoft Graph)
      const msScopes = [
        "https://graph.microsoft.com/Mail.ReadWrite",
        "https://graph.microsoft.com/Mail.Send",
        "https://graph.microsoft.com/User.Read",
        "offline_access",
      ].join(" ");
      oauthUrl = `https://login.microsoftonline.com/${MICROSOFT_TENANT_ID}/oauth2/v2.0/authorize?client_id=${MICROSOFT_CLIENT_ID}&redirect_uri=${encodeURIComponent(MICROSOFT_OAUTH_REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(msScopes)}&state=${encodeURIComponent(state)}`;
    } else if (platform === "slack") {
      // Slack OAuth2 with bot scopes for messaging
      const slackScopes = [
        "channels:history",
        "channels:read",
        "chat:write",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "users:read",
      ].join(",");
      oauthUrl = `https://slack.com/oauth/v2/authorize?client_id=${SLACK_CLIENT_ID}&redirect_uri=${encodeURIComponent(SLACK_OAUTH_REDIRECT_URI)}&scope=${encodeURIComponent(slackScopes)}&state=${encodeURIComponent(state)}`;
    } else if (platform === "instagram") {
      // Instagram API with Instagram Login - connects an Instagram professional
      // (Business/Creator) account DIRECTLY. The consent screen is Instagram-only;
      // there is no Facebook Page picker because no Page is involved. Scopes are
      // comma-separated, business-prefixed.
      const igScopes = [
        "instagram_business_basic",
        "instagram_business_manage_messages",
        "instagram_business_manage_comments",
      ].join(",");
      oauthUrl = `https://www.instagram.com/oauth/authorize?client_id=${INSTAGRAM_APP_ID}&redirect_uri=${encodeURIComponent(INSTAGRAM_OAUTH_REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(igScopes)}&state=${encodeURIComponent(state)}`;
    } else {
      // Messenger (Facebook Login for Pages)
      const scopes: Record<string, string> = {
        messenger: "pages_show_list,pages_messaging,pages_manage_metadata,pages_read_engagement",
      };
      oauthUrl = `https://www.facebook.com/v25.0/dialog/oauth?client_id=${META_APP_ID}&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT_URI)}&state=${encodeURIComponent(state)}&scope=${scopes[platform]}`;
    }

    res.redirect(oauthUrl);
  } catch (err) {
    console.error("OAuth init error:", err);
    res.status(500).json({ error: "Failed to initialize OAuth" });
  }
});

// ─── OAuth Callback ──────────────────────────────────────────

router.get("/oauth/callback", async (req: Request, res: Response) => {
  // Note: This endpoint does NOT use authenticate middleware since it's a redirect from Meta
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";

  try {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
      res.redirect(`${frontendUrl}/channels?error=${encodeURIComponent(oauthError as string)}`);
      return;
    }

    if (!code || !state) {
      res.redirect(`${frontendUrl}/channels?error=missing_params`);
      return;
    }

    // Verify AND consume the state - single use, so a captured callback URL
    // cannot be replayed to re-link a channel.
    // NOTE: the state value itself is never logged. It is a bearer token for
    // this flow; echoing it into logs is exactly how a replay gets handed to
    // whoever can read them.
    const consumedState = await consumeOAuthState<{ tenantId: string; userId: string; platform: string; wabaId?: string; phoneNumberId?: string }>(
      state as string, "meta_channels",
    );
    if (!consumedState.ok) {
      console.error(`[OAUTH-CALLBACK] state rejected: ${consumedState.reason}`);
      res.redirect(`${frontendUrl}/channels?error=${consumedState.reason === "replayed" ? "state_already_used" : "invalid_state"}`);
      return;
    }
    const statePayload: any = consumedState.claims;

    const { tenantId, userId, platform } = statePayload;

    let accessToken: string;
    let tokenExpiresAt: Date;
    // Instagram-Login: the IG professional account ID (user_id) returned by the
    // token exchange, carried into the storage branch below.
    let igLoginUserId = "";

    if (platform === "whatsapp") {
      // WhatsApp Embedded Signup: exchange code for business token
      // Try GET first (per official docs), then POST with grant_type as fallback
      console.log("[WA-CALLBACK] Exchanging code for WhatsApp business token...");
      let token: string | undefined;

      // Try GET (official docs method)
      try {
        const resp = await axios.get(`${FB_API_URL}/oauth/access_token`, {
          params: { client_id: META_APP_ID, client_secret: META_APP_SECRET, redirect_uri: OAUTH_REDIRECT_URI, code },
        });
        token = resp.data.access_token || (typeof resp.data === "string" ? resp.data : undefined);
      } catch (e: any) {
        console.warn("[WA-CALLBACK] GET exchange failed:", e.response?.data?.error?.message);
      }

      // Fallback: POST with grant_type
      if (!token) {
        try {
          const resp = await axios.post(`${FB_API_URL}/oauth/access_token`, {
            client_id: META_APP_ID, client_secret: META_APP_SECRET,
            grant_type: "authorization_code", redirect_uri: OAUTH_REDIRECT_URI, code,
          }, { headers: { "Content-Type": "application/json" } });
          token = resp.data.access_token;
        } catch (e: any) {
          console.warn("[WA-CALLBACK] POST exchange failed:", e.response?.data?.error?.message);
        }
      }

      if (!token) {
        res.redirect(`${frontendUrl}/channels?error=token_exchange_failed`);
        return;
      }
      accessToken = token;
      tokenExpiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // Business tokens don't expire
      console.log("[WA-CALLBACK] Business token obtained successfully");
    } else if (platform === "messenger") {
      // Messenger: standard Facebook OAuth token exchange
      const tokenResponse = await axios.get(`${FB_API_URL}/oauth/access_token`, {
        params: {
          client_id: META_APP_ID,
          client_secret: META_APP_SECRET,
          redirect_uri: OAUTH_REDIRECT_URI,
          code,
        },
      });
      const shortLivedToken = tokenResponse.data.access_token;

      // Exchange for long-lived token (60 days)
      let longLivedToken = shortLivedToken;
      let expiresIn = 5184000;
      try {
        const longLivedResponse = await axios.get(`${FB_API_URL}/oauth/access_token`, {
          params: {
            grant_type: "fb_exchange_token",
            client_id: META_APP_ID,
            client_secret: META_APP_SECRET,
            fb_exchange_token: shortLivedToken,
          },
        });
        longLivedToken = longLivedResponse.data.access_token || shortLivedToken;
        expiresIn = longLivedResponse.data.expires_in || 5184000;
      } catch (exchangeErr: any) {
        console.warn("Long-lived token exchange failed:", exchangeErr.response?.data?.error?.message);
      }
      accessToken = longLivedToken;
      tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);
    } else if (platform === "instagram") {
      // Instagram Login token exchange (two steps, against Instagram's own hosts).
      // Step 1: short-lived token + the IG professional account id (user_id).
      const form = new URLSearchParams();
      form.append("client_id", INSTAGRAM_APP_ID);
      form.append("client_secret", INSTAGRAM_APP_SECRET);
      form.append("grant_type", "authorization_code");
      form.append("redirect_uri", INSTAGRAM_OAUTH_REDIRECT_URI);
      form.append("code", code as string);

      let shortLivedToken: string | undefined;
      try {
        const tokenResponse = await axios.post(
          "https://api.instagram.com/oauth/access_token",
          form,
          { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
        );
        shortLivedToken = tokenResponse.data?.access_token;
        igLoginUserId = String(tokenResponse.data?.user_id || "");
        console.log("[INSTAGRAM-CALLBACK] token-exchange response:", JSON.stringify({
          user_id: tokenResponse.data?.user_id,
          permissions: tokenResponse.data?.permissions,
          token_len: (tokenResponse.data?.access_token || "").length,
          token_head: (tokenResponse.data?.access_token || "").slice(0, 6),
        }));
      } catch (igErr: any) {
        console.error("[INSTAGRAM-CALLBACK] Token exchange failed:", igErr.response?.data || igErr.message);
      }

      if (!shortLivedToken) {
        res.redirect(`${frontendUrl}/channels?error=token_exchange_failed`);
        return;
      }

      // Step 2: exchange the short-lived (1h) token for a long-lived (~60d) one.
      let longLivedToken = shortLivedToken;
      let expiresIn = 5184000;
      try {
        const longLivedResponse = await axios.get(`${IG_API_URL}/access_token`, {
          params: {
            grant_type: "ig_exchange_token",
            client_secret: INSTAGRAM_APP_SECRET,
            access_token: shortLivedToken,
          },
        });
        longLivedToken = longLivedResponse.data?.access_token || shortLivedToken;
        expiresIn = longLivedResponse.data?.expires_in || 5184000;
      } catch (exchangeErr: any) {
        console.warn("[INSTAGRAM-CALLBACK] Long-lived token exchange failed:", exchangeErr.response?.data?.error?.message);
      }
      accessToken = longLivedToken;
      tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);
    } else {
      // Gmail, Outlook, Slack: token exchange handled in platform-specific section below
      accessToken = "";
      tokenExpiresAt = new Date();
    }

    const connectedAccounts: string[] = [];
    const redis = getRedis();

    if (platform === "whatsapp") {
      // ─── WHATSAPP ──────────────────────────────────────
      // Get session info from state JWT (passed from popup → redirect)
      let wabaId = statePayload.wabaId || "";
      let phoneNumberIds: string[] = statePayload.phoneNumberId ? [statePayload.phoneNumberId] : [];

      // If no session info, try debug_token discovery
      if (!wabaId) {
        console.log("[WA-CALLBACK] No session WABA ID, trying debug_token...");
        try {
          const debugResponse = await axios.get(`${FB_API_URL}/debug_token`, {
            params: { input_token: accessToken },
            headers: { Authorization: `Bearer ${META_APP_ID}|${META_APP_SECRET}` },
          });
          const debugData = debugResponse.data?.data;
          console.log("[WA-CALLBACK] debug_token:", JSON.stringify(debugData?.granular_scopes, null, 2));
          const granularScopes = debugData?.granular_scopes || [];
          const wabaScope = granularScopes.find((s: any) => s.scope === "whatsapp_business_management");
          const wabaIds = wabaScope?.target_ids || [];
          if (wabaIds.length > 0) wabaId = wabaIds[0];
        } catch (debugErr: any) {
          console.warn("[WA-CALLBACK] debug_token failed:", debugErr.response?.data?.error?.message);
        }
      }

      if (!wabaId) {
        // Store the token in Redis for later completion (when session info arrives from popup)
        console.log("[WA-CALLBACK] No WABA found. Storing token for session completion...");
        await redis.set(`wa_pending_token:${tenantId}`, accessToken, "EX", 300); // 5 min TTL
        res.redirect(`${frontendUrl}/channels?connected=whatsapp&pending=true`);
        return;
      }

      console.log("[WA-CALLBACK] Using WABA:", wabaId);

      // Subscribe app to WABA webhooks
      try {
        await axios.post(`${FB_API_URL}/${wabaId}/subscribed_apps`, {}, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
      } catch (subErr: any) {
        console.warn("[WA-CALLBACK] Webhook subscription warning:", subErr.response?.data?.error?.message);
      }

      // If we don't have phone number IDs, fetch from WABA
      if (phoneNumberIds.length === 0) {
        try {
          const phonesResponse = await axios.get(`${FB_API_URL}/${wabaId}/phone_numbers`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          phoneNumberIds = (phonesResponse.data?.data || []).map((p: any) => p.id);
        } catch (phonesErr: any) {
          console.warn("[WA-CALLBACK] Phone numbers fetch failed:", phonesErr.response?.data?.error?.message);
        }
      }

      for (const phoneNumberId of phoneNumberIds) {
        let phoneDetails: any = { id: phoneNumberId };
        try {
          const resp = await axios.get(`${FB_API_URL}/${phoneNumberId}`, {
            params: { fields: "id,display_phone_number,verified_name,quality_rating" },
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          phoneDetails = resp.data;
        } catch {}

        const displayPhone = phoneDetails.display_phone_number || phoneDetails.verified_name || phoneNumberId;

        // Register phone number
        try {
          await axios.post(`${FB_API_URL}/${phoneNumberId}/register`,
            { messaging_product: "whatsapp", pin: "000000" },
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );
        } catch (regErr: any) {
          console.warn(`[WA-CALLBACK] Phone reg note ${phoneNumberId}:`, regErr.response?.data?.error?.message);
        }

        // Unique-key lookup; refuse if already bound to a different tenant.
        const existing = await prisma.channelAccount.findUnique({
          where: { channel_externalId: { channel: "WHATSAPP", externalId: phoneNumberId } },
        });
        if (existing && existing.tenantId !== tenantId) continue;

        const credentials = encryptCredentials({ accessToken, wabaId, phoneNumber: displayPhone });

        if (existing) {
          await prisma.channelAccount.update({
            where: { id: existing.id },
            data: { credentials, connectionStatus: "CONNECTED", connectedAt: new Date(), connectedBy: userId, tokenExpiresAt, isActive: true, lastError: null, displayName: phoneDetails.verified_name || displayPhone, platformMeta: { wabaId, qualityRating: phoneDetails.quality_rating } },
          });
        } else {
          await prisma.channelAccount.create({
            data: { tenantId, channel: "WHATSAPP", externalId: phoneNumberId, displayName: phoneDetails.verified_name || displayPhone, credentials, connectionStatus: "CONNECTED", connectedAt: new Date(), connectedBy: userId, tokenExpiresAt, isActive: true, platformMeta: { wabaId, qualityRating: phoneDetails.quality_rating } },
          });
        }

        await redis.del(`channel_account:WHATSAPP:${phoneNumberId}`);
        connectedAccounts.push(phoneDetails.verified_name || displayPhone);
      }

      if (connectedAccounts.length === 0) {
        res.redirect(`${frontendUrl}/channels?error=no_whatsapp_numbers`);
        return;
      }
    } else if (platform === "messenger") {
      // ─── MESSENGER ──────────────────────────────────────
      // Try /me/accounts first (standard Facebook Login)
      const pagesResponse = await axios.get(`${FB_API_URL}/me/accounts`, {
        params: { access_token: accessToken, fields: "id,name,access_token,category" },
      });
      let pages: any[] = pagesResponse.data?.data || [];
      console.log("[MESSENGER-CALLBACK] /me/accounts returned", pages.length, "pages");

      // If empty, token may be from Facebook Login for Business.
      // Fall back to debug_token to discover granted page IDs from granular_scopes.
      if (pages.length === 0) {
        console.log("[MESSENGER-CALLBACK] /me/accounts empty, trying debug_token to discover pages...");
        try {
          const debugResponse = await axios.get(`${FB_API_URL}/debug_token`, {
            params: { input_token: accessToken },
            headers: { Authorization: `Bearer ${META_APP_ID}|${META_APP_SECRET}` },
          });
          const granularScopes = debugResponse.data?.data?.granular_scopes || [];
          console.log("[MESSENGER-CALLBACK] debug_token granular_scopes:", JSON.stringify(granularScopes));

          // Collect page IDs from any page-related scope
          const pageIdSet = new Set<string>();
          for (const scope of granularScopes) {
            if (scope.target_ids && Array.isArray(scope.target_ids)) {
              for (const id of scope.target_ids) pageIdSet.add(id);
            }
          }
          const discoveredPageIds = Array.from(pageIdSet);
          console.log("[MESSENGER-CALLBACK] Discovered page IDs:", discoveredPageIds);

          // Fetch each page's details + page access token
          for (const pageId of discoveredPageIds) {
            try {
              const pageResp = await axios.get(`${FB_API_URL}/${pageId}`, {
                params: { fields: "id,name,access_token,category", access_token: accessToken },
              });
              if (pageResp.data?.id) {
                pages.push(pageResp.data);
              }
            } catch (pageErr: any) {
              console.warn(`[MESSENGER-CALLBACK] Failed to fetch page ${pageId}:`, pageErr.response?.data?.error?.message);
            }
          }
          console.log("[MESSENGER-CALLBACK] Resolved", pages.length, "pages from debug_token");
        } catch (debugErr: any) {
          console.warn("[MESSENGER-CALLBACK] debug_token failed:", debugErr.response?.data?.error?.message);
        }
      }

      if (pages.length === 0) {
        console.error("[MESSENGER-CALLBACK] No pages found via /me/accounts or debug_token");
        res.redirect(`${frontendUrl}/channels?error=no_pages`);
        return;
      }

      for (const page of pages) {
        const pageId = page.id;
        const pageAccessToken = page.access_token;
        const pageName = page.name || pageId;

        if (!pageAccessToken) {
          console.warn(`[MESSENGER-CALLBACK] No access_token for page ${pageId}, skipping`);
          continue;
        }

        // Subscribe page to webhooks. `feed` delivers comment + post events
        // for the FB page - required for the Comment Trigger to fire.
        // `message_reactions` delivers reactions to inbound messages.
        try {
          const pageSubResp = await axios.post(`${FB_API_URL}/${pageId}/subscribed_apps`, null, {
            params: {
              subscribed_fields: "messages,messaging_postbacks,messaging_optins,message_deliveries,message_reads,message_reactions,feed",
              access_token: pageAccessToken,
            },
          });
          console.log(`[MESSENGER-CALLBACK] Page ${pageId} subscribed_apps result:`, pageSubResp.data);
        } catch (subErr: any) {
          console.error(`[MESSENGER-CALLBACK] Page subscription FAILED for ${pageId}:`, subErr.response?.data || subErr.message);
        }

        // Unique-key lookup on (channel, externalId). Detects a page bound
        // to a different tenant so we can refuse instead of silently
        // overwriting; findUnique on a unique index is exempt from
        // TenantGuard (see prisma.ts).
        const existing = await prisma.channelAccount.findUnique({
          where: { channel_externalId: { channel: "MESSENGER", externalId: pageId } },
        });

        if (existing && existing.tenantId !== tenantId) {
          console.warn(`Messenger page ${pageId} already connected to another tenant`);
          continue;
        }

        const credentials = encryptCredentials({
          accessToken: pageAccessToken,
          userId,
          pageId,
          pageName,
        });

        if (existing) {
          await prisma.channelAccount.update({
            where: { id: existing.id },
            data: {
              credentials,
              connectionStatus: "CONNECTED",
              connectedAt: new Date(),
              connectedBy: userId,
              tokenExpiresAt,
              isActive: true,
              lastError: null,
              displayName: pageName,
            },
          });
        } else {
          await prisma.channelAccount.create({
            data: {
              tenantId,
              channel: "MESSENGER",
              externalId: pageId,
              displayName: pageName,
              credentials,
              connectionStatus: "CONNECTED",
              connectedAt: new Date(),
              connectedBy: userId,
              tokenExpiresAt,
              isActive: true,
            },
          });
        }

        await redis.del(`channel_account:MESSENGER:${pageId}`);
        connectedAccounts.push(pageName);
      }
    } else if (platform === "instagram") {
      // ─── INSTAGRAM (Instagram API with Instagram Login) ──
      // No Facebook Page involved: the IG professional account is connected
      // directly, the token is an IG-user token (graph.instagram.com host),
      // and webhooks are subscribed on the IG account itself.

      // Resolve the IG professional account id + username from the token.
      let igBusinessId = igLoginUserId;
      let igUsername = "";
      try {
        const profileResp = await axios.get(`${IG_API_URL}/me`, {
          params: { fields: "user_id,username", access_token: accessToken },
        });
        igBusinessId = String(profileResp.data?.user_id || igLoginUserId);
        igUsername = profileResp.data?.username || igBusinessId;
      } catch (profileErr: any) {
        console.warn("[INSTAGRAM-CALLBACK] Profile fetch failed:", profileErr.response?.data?.error?.message);
        igUsername = igBusinessId;
      }

      if (!igBusinessId) {
        console.error("[INSTAGRAM-CALLBACK] No IG account id resolved from token");
        res.redirect(`${frontendUrl}/channels?error=no_instagram_account`);
        return;
      }

      // Subscribe THIS Instagram account to the app's webhooks. With Instagram
      // Login the subscription is per-account (no Page), via /me/subscribed_apps.
      // The webhook callback URL + verify token are configured under the
      // Instagram product in the Meta App Dashboard, not via API.
      try {
        const subResp = await axios.post(`${IG_API_URL}/me/subscribed_apps`, null, {
          params: {
            subscribed_fields: "messages,messaging_postbacks,comments,message_reactions",
            access_token: accessToken,
          },
        });
        console.log(`[INSTAGRAM-CALLBACK] IG ${igBusinessId} subscribed_apps result:`, subResp.data);
      } catch (subErr: any) {
        console.error(`[INSTAGRAM-CALLBACK] IG subscription FAILED for ${igBusinessId}:`, subErr.response?.data || subErr.message);
      }

      // Unique-key lookup on (channel, externalId) - see Messenger.
      const existing = await prisma.channelAccount.findUnique({
        where: { channel_externalId: { channel: "INSTAGRAM", externalId: igBusinessId } },
      });

      if (existing && existing.tenantId !== tenantId) {
        console.warn(`Instagram account ${igBusinessId} already connected to another tenant`);
        res.redirect(`${frontendUrl}/channels?error=already_connected`);
        return;
      }

      const credentials = encryptCredentials({
        accessToken,        // IG-user token; used against graph.instagram.com
        igBusinessId,
        igUsername,
        igLogin: true,      // adapter switches host based on this flag
      });

      if (existing) {
        await prisma.channelAccount.update({
          where: { id: existing.id },
          data: {
            credentials,
            connectionStatus: "CONNECTED",
            connectedAt: new Date(),
            connectedBy: userId,
            tokenExpiresAt,
            isActive: true,
            lastError: null,
            displayName: `@${igUsername}`,
          },
        });
      } else {
        await prisma.channelAccount.create({
          data: {
            tenantId,
            channel: "INSTAGRAM",
            externalId: igBusinessId,
            displayName: `@${igUsername}`,
            credentials,
            connectionStatus: "CONNECTED",
            connectedAt: new Date(),
            connectedBy: userId,
            tokenExpiresAt,
            isActive: true,
            platformMeta: { igLogin: true },
          },
        });
      }

      await redis.del(`channel_account:INSTAGRAM:${igBusinessId}`);
      connectedAccounts.push(`@${igUsername}`);

      if (connectedAccounts.length === 0) {
        res.redirect(`${frontendUrl}/channels?error=no_instagram_account`);
        return;
      }
    } else if (platform === "gmail") {
      // ─── GMAIL ───────────────────────────────────────────
      // Exchange code for tokens
      const tokenResponse = await axios.post("https://oauth2.googleapis.com/token", {
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
      });

      const { access_token: gmailAccessToken, refresh_token: gmailRefreshToken, expires_in } = tokenResponse.data;
      tokenExpiresAt = new Date(Date.now() + (expires_in || 3600) * 1000);

      // Get user email address
      const profileResponse = await axios.get("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${gmailAccessToken}` },
      });
      const emailAddress = profileResponse.data.email;
      const displayName = profileResponse.data.name || emailAddress;

      if (!emailAddress) {
        res.redirect(`${frontendUrl}/channels?error=gmail_no_email`);
        return;
      }

      // Set up Gmail push notifications via Pub/Sub
      try {
        const watchTopic = process.env.GMAIL_PUBSUB_TOPIC || "";
        if (watchTopic) {
          await axios.post(
            `https://gmail.googleapis.com/gmail/v1/users/me/watch`,
            { topicName: watchTopic, labelIds: ["INBOX"] },
            { headers: { Authorization: `Bearer ${gmailAccessToken}` } }
          );
          console.log(`[GMAIL-CALLBACK] Push notifications enabled for ${emailAddress}`);
        }
      } catch (watchErr: any) {
        console.warn("[GMAIL-CALLBACK] Watch setup warning:", watchErr.response?.data || watchErr.message);
      }

      // Get current historyId for tracking new messages going forward
      let initialHistoryId: string | undefined;
      try {
        const gmailProfileRes = await axios.get(
          "https://gmail.googleapis.com/gmail/v1/users/me/profile",
          { headers: { Authorization: `Bearer ${gmailAccessToken}` } }
        );
        initialHistoryId = gmailProfileRes.data.historyId?.toString();
        console.log(`[GMAIL-CALLBACK] Initial historyId: ${initialHistoryId}`);
      } catch (histErr: any) {
        console.warn("[GMAIL-CALLBACK] Failed to get historyId:", histErr.response?.data || histErr.message);
      }

      // Unique-key lookup; refuse if mailbox is already bound elsewhere.
      const existing = await prisma.channelAccount.findUnique({
        where: { channel_externalId: { channel: "GMAIL", externalId: emailAddress } },
      });

      if (existing && existing.tenantId !== tenantId) {
        res.redirect(`${frontendUrl}/channels?error=gmail_already_connected`);
        return;
      }

      const credentials = encryptCredentials({
        accessToken: gmailAccessToken,
        refreshToken: gmailRefreshToken,
        clientId: GOOGLE_CLIENT_ID,
        clientSecret: GOOGLE_CLIENT_SECRET,
        fromAddress: emailAddress,
      });

      const gmailPlatformMeta = {
        ...(existing ? (existing.platformMeta as any) || {} : {}),
        ...(initialHistoryId ? { lastHistoryId: initialHistoryId } : {}),
      };

      if (existing) {
        await prisma.channelAccount.update({
          where: { id: existing.id },
          data: {
            credentials,
            connectionStatus: "CONNECTED",
            connectedAt: new Date(),
            connectedBy: userId,
            tokenExpiresAt,
            isActive: true,
            lastError: null,
            displayName,
            responseMode: "HUMAN_WITH_COPILOT",
            platformMeta: gmailPlatformMeta,
          },
        });
      } else {
        await prisma.channelAccount.create({
          data: {
            tenantId,
            channel: "GMAIL",
            externalId: emailAddress,
            displayName,
            credentials,
            connectionStatus: "CONNECTED",
            connectedAt: new Date(),
            connectedBy: userId,
            tokenExpiresAt,
            isActive: true,
            responseMode: "HUMAN_WITH_COPILOT",
            platformMeta: gmailPlatformMeta,
          },
        });
      }

      await redis.del(`channel_account:GMAIL:${emailAddress}`);

      // Auto-create a default router rule for this Gmail channel (if none exists)
      await ensureEmailRouterRule(tenantId, "GMAIL", displayName);

      connectedAccounts.push(displayName);
    } else if (platform === "outlook") {
      // ─── OUTLOOK ─────────────────────────────────────────
      // Exchange code for tokens
      const tokenResponse = await axios.post(
        `https://login.microsoftonline.com/${MICROSOFT_TENANT_ID}/oauth2/v2.0/token`,
        new URLSearchParams({
          client_id: MICROSOFT_CLIENT_ID,
          client_secret: MICROSOFT_CLIENT_SECRET,
          code: code as string,
          grant_type: "authorization_code",
          redirect_uri: MICROSOFT_OAUTH_REDIRECT_URI,
          scope: "https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read offline_access",
        }).toString(),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
      );

      const { access_token: outlookAccessToken, refresh_token: outlookRefreshToken, expires_in: outlookExpiresIn } = tokenResponse.data;
      tokenExpiresAt = new Date(Date.now() + (outlookExpiresIn || 3600) * 1000);

      // Get user profile
      const profileResponse = await axios.get("https://graph.microsoft.com/v1.0/me", {
        headers: { Authorization: `Bearer ${outlookAccessToken}` },
      });
      const emailAddress = profileResponse.data.mail || profileResponse.data.userPrincipalName;
      const displayName = profileResponse.data.displayName || emailAddress;

      if (!emailAddress) {
        res.redirect(`${frontendUrl}/channels?error=outlook_no_email`);
        return;
      }

      // Create a mail subscription for incoming messages via Microsoft Graph webhooks
      const webhookUrl = process.env.OUTLOOK_WEBHOOK_URL || "";
      let subscriptionId: string | null = null;
      if (webhookUrl) {
        try {
          const clientState = crypto.randomBytes(16).toString("hex");
          const subscriptionResponse = await axios.post(
            "https://graph.microsoft.com/v1.0/subscriptions",
            {
              changeType: "created",
              notificationUrl: webhookUrl,
              resource: "me/mailFolders('Inbox')/messages",
              expirationDateTime: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 days max
              clientState,
            },
            { headers: { Authorization: `Bearer ${outlookAccessToken}`, "Content-Type": "application/json" } }
          );
          subscriptionId = subscriptionResponse.data.id;
          console.log(`[OUTLOOK-CALLBACK] Webhook subscription created: ${subscriptionId}`);
        } catch (subErr: any) {
          console.warn("[OUTLOOK-CALLBACK] Subscription warning:", subErr.response?.data || subErr.message);
        }
      }

      // Unique-key lookup; refuse if mailbox is already bound elsewhere.
      const existing = await prisma.channelAccount.findUnique({
        where: { channel_externalId: { channel: "OUTLOOK", externalId: emailAddress } },
      });

      if (existing && existing.tenantId !== tenantId) {
        res.redirect(`${frontendUrl}/channels?error=outlook_already_connected`);
        return;
      }

      const credentials = encryptCredentials({
        accessToken: outlookAccessToken,
        refreshToken: outlookRefreshToken,
        clientId: MICROSOFT_CLIENT_ID,
        clientSecret: MICROSOFT_CLIENT_SECRET,
        tenantIdAzure: MICROSOFT_TENANT_ID,
        fromAddress: emailAddress,
      });

      if (existing) {
        await prisma.channelAccount.update({
          where: { id: existing.id },
          data: {
            credentials,
            connectionStatus: "CONNECTED",
            connectedAt: new Date(),
            connectedBy: userId,
            tokenExpiresAt,
            isActive: true,
            lastError: null,
            displayName,
            platformMeta: { subscriptionId },
            responseMode: "HUMAN_WITH_COPILOT",
          },
        });
      } else {
        await prisma.channelAccount.create({
          data: {
            tenantId,
            channel: "OUTLOOK",
            externalId: emailAddress,
            displayName,
            credentials,
            connectionStatus: "CONNECTED",
            connectedAt: new Date(),
            connectedBy: userId,
            tokenExpiresAt,
            isActive: true,
            platformMeta: { subscriptionId },
            responseMode: "HUMAN_WITH_COPILOT",
          },
        });
      }

      await redis.del(`channel_account:OUTLOOK:${emailAddress}`);

      // Auto-create a default router rule for this Outlook channel (if none exists)
      await ensureEmailRouterRule(tenantId, "OUTLOOK", displayName);

      connectedAccounts.push(displayName);
    } else if (platform === "slack") {
      // ─── SLACK ───────────────────────────────────────────
      // Exchange code for bot token (Slack V2 OAuth)
      const tokenResponse = await axios.post(
        "https://slack.com/api/oauth.v2.access",
        new URLSearchParams({
          client_id: SLACK_CLIENT_ID,
          client_secret: SLACK_CLIENT_SECRET,
          code: code as string,
          redirect_uri: SLACK_OAUTH_REDIRECT_URI,
        }).toString(),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
      );

      const slackData = tokenResponse.data;
      if (!slackData.ok) {
        console.error("[SLACK-CALLBACK] Token exchange failed:", slackData.error);
        res.redirect(`${frontendUrl}/channels?error=slack_token_failed`);
        return;
      }

      const botToken = slackData.access_token;
      const teamId = slackData.team?.id || "";
      const teamName = slackData.team?.name || teamId;
      const botUserId = slackData.bot_user_id || "";
      // Slack bot tokens don't expire
      tokenExpiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

      if (!teamId) {
        res.redirect(`${frontendUrl}/channels?error=slack_no_team`);
        return;
      }

      // Unique-key lookup; refuse if workspace is already bound elsewhere.
      const existing = await prisma.channelAccount.findUnique({
        where: { channel_externalId: { channel: "SLACK", externalId: teamId } },
      });

      if (existing && existing.tenantId !== tenantId) {
        res.redirect(`${frontendUrl}/channels?error=slack_already_connected`);
        return;
      }

      const credentials = encryptCredentials({
        accessToken: botToken,
        signingSecret: SLACK_SIGNING_SECRET,
        botUserId,
        teamId,
      });

      if (existing) {
        await prisma.channelAccount.update({
          where: { id: existing.id },
          data: {
            credentials,
            connectionStatus: "CONNECTED",
            connectedAt: new Date(),
            connectedBy: userId,
            tokenExpiresAt,
            isActive: true,
            lastError: null,
            displayName: teamName,
            platformMeta: { teamId, botUserId },
          },
        });
      } else {
        await prisma.channelAccount.create({
          data: {
            tenantId,
            channel: "SLACK",
            externalId: teamId,
            displayName: teamName,
            credentials,
            connectionStatus: "CONNECTED",
            connectedAt: new Date(),
            connectedBy: userId,
            tokenExpiresAt,
            isActive: true,
            platformMeta: { teamId, botUserId },
          },
        });
      }

      await redis.del(`channel_account:SLACK:${teamId}`);
      connectedAccounts.push(teamName);
    }

    res.redirect(`${frontendUrl}/channels?connected=${platform}&count=${connectedAccounts.length}`);
  } catch (err: any) {
    console.error("OAuth callback error:", err.response?.data || err.message);
    res.redirect(`${frontendUrl}/channels?error=connection_failed`);
  }
});

// ─── Update Channel Response Mode ────────────────────────────

const responseModeSchema = z.object({
  responseMode: z.enum(["HUMAN_WITH_COPILOT", "AI_AUTO_REPLY"]),
});

router.patch("/:id/response-mode", authenticate, resolveTenant, requireRole("ADMIN"), validate(responseModeSchema), async (req: Request, res: Response) => {
  try {
    const account = await prisma.channelAccount.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! },
    });

    if (!account) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }

    if (account.channel !== "GMAIL" && account.channel !== "OUTLOOK") {
      res.status(400).json({ error: "Response mode is only configurable for Gmail and Outlook channels" });
      return;
    }

    const updated = await prisma.channelAccount.update({
      where: { id: account.id },
      data: { responseMode: req.body.responseMode },
      select: { id: true, channel: true, displayName: true, responseMode: true },
    });

    res.json({ data: updated });
  } catch (err) {
    console.error("Update response mode error:", err);
    res.status(500).json({ error: "Failed to update response mode" });
  }
});

// ─── Disconnect Channel ──────────────────────────────────────

router.post("/:id/disconnect", authenticate, resolveTenant, requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const account = await prisma.channelAccount.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! },
    });

    if (!account) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }

    // Attempt platform-specific cleanup
    try {
      const credentials = typeof account.credentials === "string"
        ? decryptCredentials(account.credentials as string)
        : (account.credentials as any);

      const accessToken = credentials?.accessToken;

      if (accessToken) {
        if (account.channel === "WHATSAPP") {
          const wabaId = credentials.wabaId;
          if (wabaId) {
            await axios.delete(`${FB_API_URL}/${wabaId}/subscribed_apps`, {
              headers: { Authorization: `Bearer ${accessToken}` },
            });
          }
        } else if (account.channel === "MESSENGER") {
          const pageId = account.externalId;
          await axios.delete(`${FB_API_URL}/${pageId}/subscribed_apps`, {
            params: { access_token: accessToken },
          });
        } else if (account.channel === "INSTAGRAM") {
          const pageId = credentials.pageId || (account.platformMeta as any)?.pageId;
          if (pageId) {
            await axios.delete(`${FB_API_URL}/${pageId}/subscribed_apps`, {
              params: { access_token: accessToken },
            });
          }
        } else if (account.channel === "GMAIL") {
          // Stop Gmail push notifications
          await axios.post(
            "https://gmail.googleapis.com/gmail/v1/users/me/stop",
            {},
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );
        } else if (account.channel === "OUTLOOK") {
          // Delete Microsoft Graph webhook subscription
          const subscriptionId = (account.platformMeta as any)?.subscriptionId;
          if (subscriptionId) {
            await axios.delete(`https://graph.microsoft.com/v1.0/subscriptions/${subscriptionId}`, {
              headers: { Authorization: `Bearer ${accessToken}` },
            });
          }
        } else if (account.channel === "SLACK") {
          // Revoke Slack bot token
          await axios.post("https://slack.com/api/auth.revoke", null, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
        }
      }
    } catch (cleanupErr: any) {
      // Log but don't fail - we still want to disconnect locally even if Meta API fails
      console.warn("Channel disconnect cleanup warning:", cleanupErr.response?.data || cleanupErr.message);
    }

    // Soft disconnect: keep record, clear credentials
    await prisma.channelAccount.update({
      where: { id: account.id },
      data: {
        connectionStatus: "DISCONNECTED",
        isActive: false,
        credentials: {},
        lastError: null,
      },
    });

    // Invalidate Redis cache
    const redis = getRedis();
    await redis.del(`channel_account:${account.channel}:${account.externalId}`);

    res.json({ success: true });
  } catch (err) {
    console.error("Disconnect channel error:", err);
    res.status(500).json({ error: "Failed to disconnect channel" });
  }
});

// ─── Delete Channel Account (with cascade) ───────────────────

router.delete("/:id", authenticate, resolveTenant, requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const account = await prisma.channelAccount.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! },
    });
    if (!account) {
      res.status(404).json({ error: "Channel account not found" });
      return;
    }

    const channelAccountId = account.id;

    const { deletedMessages, deletedConversations } = await prisma.$transaction(async (tx) => {
      const deletedMessages = await tx.message.deleteMany({
        where: { conversation: { channelAccountId } },
      });
      const deletedConversations = await tx.conversation.deleteMany({
        where: { channelAccountId },
      });
      await tx.channelAccount.delete({ where: { id: channelAccountId } });
      return { deletedMessages, deletedConversations };
    });

    // Invalidate Redis cache
    const redis = getRedis();
    await redis.del(`channel_account:${account.channel}:${account.externalId}`);

    res.json({
      data: {
        deleted: true,
        channelAccountId,
        deletedConversations: deletedConversations.count,
        deletedMessages: deletedMessages.count,
      },
    });
  } catch (err) {
    console.error("Delete channel account error:", err);
    res.status(500).json({ error: "Failed to delete channel account" });
  }
});

// ─── Channel Health Check ────────────────────────────────────

router.get("/:id/status", authenticate, resolveTenant, requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const account = await prisma.channelAccount.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! },
    });

    if (!account) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }

    if (account.connectionStatus === "DISCONNECTED") {
      res.json({ data: { status: "DISCONNECTED", tokenValid: false } });
      return;
    }

    let tokenValid = false;
    let tokenExpiresAt = account.tokenExpiresAt;

    try {
      const credentials = typeof account.credentials === "string"
        ? decryptCredentials(account.credentials as string)
        : (account.credentials as any);

      const accessToken = credentials?.accessToken;

      if (accessToken) {
        const metaChannels = ["WHATSAPP", "MESSENGER", "INSTAGRAM"];

        if (metaChannels.includes(account.channel)) {
          // Meta channels: use Facebook debug_token API
          const debugResponse = await axios.get(`${FB_API_URL}/debug_token`, {
            params: { input_token: accessToken },
            headers: { Authorization: `Bearer ${META_APP_ID}|${META_APP_SECRET}` },
          });

          const tokenData = debugResponse.data?.data;
          tokenValid = tokenData?.is_valid === true;

          if (tokenData?.expires_at && tokenData.expires_at > 0) {
            tokenExpiresAt = new Date(tokenData.expires_at * 1000);
          }
        } else if (account.channel === "GMAIL") {
          // Gmail: validate token via Google's tokeninfo endpoint
          const tokenInfoRes = await axios.get("https://oauth2.googleapis.com/tokeninfo", {
            params: { access_token: accessToken },
          });
          tokenValid = !!tokenInfoRes.data?.email;
          if (tokenInfoRes.data?.expires_in) {
            tokenExpiresAt = new Date(Date.now() + tokenInfoRes.data.expires_in * 1000);
          }
        } else if (account.channel === "OUTLOOK") {
          // Outlook: validate by calling Microsoft Graph /me endpoint
          const meRes = await axios.get("https://graph.microsoft.com/v1.0/me", {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          tokenValid = !!meRes.data?.id;
        } else if (account.channel === "SLACK") {
          // Slack: validate via auth.test API
          const slackRes = await axios.post("https://slack.com/api/auth.test", null, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          tokenValid = slackRes.data?.ok === true;
        } else {
          // Other channels: assume connected if token exists
          tokenValid = true;
        }
      }
    } catch (debugErr: any) {
      console.warn("Token debug error:", debugErr.response?.data || debugErr.message);
    }

    const newStatus = tokenValid ? "CONNECTED" : "ERROR";
    const lastError = tokenValid ? null : "Token is invalid or expired";

    await prisma.channelAccount.update({
      where: { id: account.id },
      data: {
        connectionStatus: newStatus,
        lastHealthCheck: new Date(),
        lastError,
        tokenExpiresAt,
      },
    });

    res.json({
      data: {
        status: newStatus,
        tokenValid,
        tokenExpiresAt,
        lastHealthCheck: new Date(),
      },
    });
  } catch (err) {
    console.error("Channel status check error:", err);
    res.status(500).json({ error: "Failed to check channel status" });
  }
});

// ─── Connect Email Channel ─────────────────────────────────────
const connectEmailSchema = z.object({
  emailAddress: z.string().email(),
  displayName: z.string().min(1),
  smtpHost: z.string().min(1),
  smtpPort: z.number().int().min(1).max(65535),
  smtpUser: z.string().min(1),
  smtpPass: z.string().min(1),
  imapHost: z.string().optional(),
  imapPort: z.number().int().min(1).max(65535).optional(),
  imapUser: z.string().optional(),
  imapPass: z.string().optional(),
});

router.post("/connect/email", authenticate, resolveTenant, requireRole("ADMIN"), validate(connectEmailSchema), async (req: Request, res: Response) => {
  try {
    const { emailAddress, displayName, smtpHost, smtpPort, smtpUser, smtpPass, imapHost, imapPort, imapUser, imapPass } = req.body;

    // Check for duplicate
    const existing = await prisma.channelAccount.findFirst({
      where: { channel: "EMAIL", externalId: emailAddress, tenantId: req.tenantId! },
    });
    if (existing) {
      res.status(409).json({ error: "This email address is already connected" });
      return;
    }

    const credentials = {
      smtpHost, smtpPort, smtpUser, smtpPass,
      imapHost, imapPort, imapUser, imapPass,
      fromAddress: emailAddress,
    };

    const channelAccount = await prisma.channelAccount.create({
      data: {
        tenantId: req.tenantId!,
        channel: "EMAIL",
        externalId: emailAddress,
        displayName,
        credentials: encryptCredentials(credentials),
        connectionStatus: "CONNECTED",
        connectedAt: new Date(),
        connectedBy: req.user!.userId,
      },
    });

    res.json({ data: [channelAccount] });
  } catch (err: any) {
    console.error("Email connection error:", err);
    res.status(500).json({ error: "Failed to connect email channel" });
  }
});

// ─── Create Embedded Chat Widget ─────────────────────────────

router.post("/webchat/create", authenticate, resolveTenant, requirePermissionOrRole("channels:manage:update", "ADMIN"), async (req: Request, res: Response) => {
  try {
    const widgetId = `widget_${crypto.randomBytes(12).toString("hex")}`;

    // Idempotent regardless of state: one widget per tenant. (Previously only
    // CONNECTED rows counted, which could mint duplicates of PENDING drafts.)
    const existing = await prisma.channelAccount.findFirst({
      where: { tenantId: req.tenantId!, channel: "WEBCHAT" },
    });

    if (existing) {
      res.json({ data: existing });
      return;
    }

    // A freshly created widget is a DRAFT (PENDING), not a connected channel:
    // there is nothing on the customer's website yet. The embedded-chat
    // runtime flips it to CONNECTED on the first real widget load - that is
    // the installation verification, and only then does it count as a
    // connected channel anywhere in the product.
    const account = await prisma.channelAccount.create({
      data: {
        tenantId: req.tenantId!,
        channel: "WEBCHAT",
        externalId: widgetId,
        displayName: req.body.name || "Website Chat Widget",
        connectionStatus: "PENDING",
        credentials: {},
      },
    });

    res.status(201).json({ data: account });
  } catch (err) {
    console.error("Create webchat widget error:", err);
    res.status(500).json({ error: "Failed to create widget" });
  }
});

// ─── Update Webchat Widget Settings ─────────────────────────

router.put("/webchat/:id/settings", authenticate, resolveTenant, async (req: Request, res: Response) => {
  try {
    const { color, iconUrl, title, subtitle, welcome, position } = req.body;
    const account = await prisma.channelAccount.findFirst({
      where: { id: String(req.params.id), tenantId: req.tenantId!, channel: "WEBCHAT" },
    });
    if (!account) { res.status(404).json({ error: "Widget not found" }); return; }

    const settings = { color, iconUrl, title, subtitle, welcome, position };
    const updated = await prisma.channelAccount.update({
      where: { id: account.id },
      data: { credentials: settings as any },
    });
    res.json({ data: updated });
  } catch (err) {
    console.error("Update webchat settings error:", err);
    res.status(500).json({ error: "Failed to update widget settings" });
  }
});

// ─── Get Webchat Widget Settings ────────────────────────────

router.get("/webchat/:id/settings", authenticate, resolveTenant, async (req: Request, res: Response) => {
  try {
    const account = await prisma.channelAccount.findFirst({
      where: { id: String(req.params.id), tenantId: req.tenantId!, channel: "WEBCHAT" },
    });
    if (!account) { res.status(404).json({ error: "Widget not found" }); return; }
    res.json({ data: account.credentials || {} });
  } catch (err) {
    console.error("Get webchat settings error:", err);
    res.status(500).json({ error: "Failed to get widget settings" });
  }
});

// ─── Get OAuth Config (for frontend) ─────────────────────────

router.get("/config", authenticate, resolveTenant, requireRole("ADMIN"), async (_req: Request, res: Response) => {
  res.json({
    data: {
      metaAppId: META_APP_ID,
      embeddedSignupConfigId: EMBEDDED_SIGNUP_CONFIG_ID,
      oauthConfigured: !!(META_APP_ID && META_APP_SECRET && OAUTH_REDIRECT_URI),
      whatsappConfigured: !!(META_APP_ID && META_APP_SECRET && EMBEDDED_SIGNUP_CONFIG_ID),
      // Per-provider readiness: a provider whose app credentials are absent
      // can never complete OAuth - the UI shows "Requires setup" instead of
      // a Connect button that dead-ends.
      providers: {
        messenger: !!(META_APP_ID && META_APP_SECRET && OAUTH_REDIRECT_URI),
        instagram: !!(INSTAGRAM_APP_ID && INSTAGRAM_OAUTH_REDIRECT_URI),
        gmail: !!(GOOGLE_CLIENT_ID && GOOGLE_OAUTH_REDIRECT_URI),
        outlook: !!(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_OAUTH_REDIRECT_URI),
        slack: !!(process.env.SLACK_CLIENT_ID && process.env.SLACK_OAUTH_REDIRECT_URI),
        whatsapp: !!(META_APP_ID && META_APP_SECRET && EMBEDDED_SIGNUP_CONFIG_ID),
      },
    },
  });
});

export default router;
