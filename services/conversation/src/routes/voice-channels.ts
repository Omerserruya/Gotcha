import { getInternalServiceKey } from "@chatcenter/shared";
/**
 * Voice Channels API - Live Call CoPilot.
 *
 * The current architecture treats each tenant's Twilio account as a single
 * `CommunicationChannel { channelType: VOICE }` row with one
 * `VoiceChannel` child holding non-secret config and N
 * `VoiceChannelPhoneNumber` rows discovered from Twilio.
 *
 * Onboarding flow (BYO):
 *   1. POST /api/voice-channels with Twilio creds
 *   2. Server creates channel rows + lists Twilio `incomingPhoneNumbers`
 *      with the just-supplied credentials. Each becomes a
 *      `VoiceChannelPhoneNumber` row (isActive=false).
 *   3. Admin picks a number in the wizard and POSTs
 *      `/numbers/:numberId/activate` - this also updates the number's
 *      `voiceUrl` on Twilio side to point at `/api/voice/incoming/voice`.
 *
 * Secrets:
 *   - `authToken` / `apiKeySecret` are AES-256-GCM encrypted via
 *     `encryptCredentials` before persistence. Never appear in GET
 *     responses, never logged.
 *   - Each channel has a `webhookSecret` (32 random bytes hex). The
 *     `accountSidFingerprint` (last 4 chars of SID) is surfaced to the
 *     admin UI for at-a-glance disambiguation.
 */
import crypto from "crypto";
import { Router, Request, Response, NextFunction } from "express";
import {
  prisma,
  authenticate,
  resolveTenant,
  requireActiveTenant,
  requireRole,
  encryptCredentials,
  decryptCredentials,
  getRedis,
  CopilotConfigSchema,
  requireEntitlement,
  requireCapacity,
  resolveVoicePublicUrl,
  reportOperationalFailure,
  ERROR_CODES,
} from "@chatcenter/shared";

const router = Router();

/**
 * The VOICE origin (voice.gotcha.co.il), not the application origin.
 *
 * These two URLs are written onto the merchant's Twilio number, so getting the
 * host wrong does not surface as an error - the number simply stops reaching
 * us. resolveVoicePublicUrl throws in production when VOICE_PUBLIC_URL is
 * unset rather than falling back to localhost, which is what this used to do.
 */
function publicBaseUrl(): string {
  return resolveVoicePublicUrl(process.env).replace(/\/+$/, "");
}

function inboundVoiceWebhookUrl(): string {
  return `${publicBaseUrl()}/api/voice/incoming/voice`;
}
function inboundStatusWebhookUrl(): string {
  return `${publicBaseUrl()}/api/voice/incoming/status`;
}

function fingerprint(accountSid: string | null | undefined): string | null {
  if (!accountSid || typeof accountSid !== "string") return null;
  return accountSid.slice(-4);
}

interface ChannelRow {
  id: string;
  friendlyName: string;
  status: string;
  authType: string;
  channelType: string;
  provider: string;
  capabilities: unknown;
  config: unknown;
  webhookSecret: string | null;
  healthCheckedAt: Date | null;
  healthStatus: string | null;
  createdAt: Date;
  updatedAt: Date;
  encryptedSecrets: Buffer | null;
  voiceChannel: {
    id: string;
    accountSid: string | null;
    twimlAppSid: string | null;
    apiKeySid: string | null;
    copilotConfig: unknown;
    aiAgentId: string | null;
    phoneNumbers: PhoneNumberRow[];
  } | null;
}

interface PhoneNumberRow {
  id: string;
  e164: string;
  twilioSid: string | null;
  friendlyName: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface ByoCredentials {
  authToken?: string;
  apiKeySecret?: string | null;
}

function serializePhoneNumber(row: PhoneNumberRow) {
  return {
    id: row.id,
    e164: row.e164,
    twilioSid: row.twilioSid,
    friendlyName: row.friendlyName,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function serializeChannel(row: ChannelRow) {
  // `numbers` is exposed BOTH at the top level (frontend contract - see
  // `VoiceChannel` in `frontend/src/lib/api.ts`) AND nested under
  // `voiceChannel` for any consumer that wants the joined-row shape.
  // Always an array, never `undefined`, so renderers can `.length`/`.map`
  // without null-checks even when Twilio discovery was skipped.
  const numbers = (row.voiceChannel?.phoneNumbers ?? []).map(serializePhoneNumber);
  return {
    id: row.id,
    friendlyName: row.friendlyName,
    status: row.status,
    authType: row.authType,
    channelType: row.channelType,
    provider: row.provider,
    capabilities: row.capabilities,
    config: row.config,
    webhookSecret: row.webhookSecret,
    healthCheckedAt: row.healthCheckedAt,
    healthStatus: row.healthStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    hasAuthToken: Boolean(row.encryptedSecrets),
    accountSidFingerprint: fingerprint(row.voiceChannel?.accountSid ?? null),
    numbers,
    aiAgentId: row.voiceChannel?.aiAgentId ?? null,
    // Pipeline funnel override - still lives inside the copilot_config JSONB
    // (`copilot_config.funnelId`) pending Phase 7 promotion to a real FK
    // column. Surface it at the top level so the detail page can render the
    // picker without parsing the blob.
    funnelId: (() => {
      const cfg = (row.voiceChannel?.copilotConfig ?? {}) as Record<string, unknown>;
      return typeof cfg.funnelId === "string" && cfg.funnelId.length > 0 ? cfg.funnelId : null;
    })(),
    voiceChannel: row.voiceChannel
      ? {
          id: row.voiceChannel.id,
          accountSid: row.voiceChannel.accountSid,
          twimlAppSid: row.voiceChannel.twimlAppSid,
          apiKeySid: row.voiceChannel.apiKeySid,
          copilotConfig: row.voiceChannel.copilotConfig ?? {},
          aiAgentId: row.voiceChannel.aiAgentId ?? null,
          numbers,
        }
      : null,
  };
}

const CHANNEL_INCLUDE = {
  voiceChannel: {
    include: { phoneNumbers: { orderBy: { createdAt: "asc" as const } } },
  },
} as const;

// ─── Twilio API dispatcher (BYO Basic auth) ─────────────────
interface TwilioApiContext {
  channelId: string;
  accountSid: string;
  authToken: string;
}

async function twilioApiCall(
  ctx: TwilioApiContext,
  method: "GET" | "POST",
  path: string,
  params?: Record<string, string>,
): Promise<unknown> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(ctx.accountSid)}${path}`;
  const basic = Buffer.from(`${ctx.accountSid}:${ctx.authToken}`).toString("base64");
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
  };
  let fullUrl = url;
  if (params) {
    if (method === "POST") {
      init.body = new URLSearchParams(params).toString();
    } else {
      fullUrl = `${url}?${new URLSearchParams(params).toString()}`;
    }
  }
  const resp = await fetch(fullUrl, init);
  if (!resp.ok) {
    throw new Error(`twilio_api_${resp.status}: ${await resp.text()}`);
  }
  if (resp.status === 204) return {};
  return resp.json();
}

// ─── Twilio helpers ─────────────────────────────────────────
async function listIncomingPhoneNumbers(ctx: TwilioApiContext): Promise<Array<{
  sid: string;
  phoneNumber: string;
  friendlyName?: string | null;
}>> {
  const data = (await twilioApiCall(ctx, "GET", `/IncomingPhoneNumbers.json`, { PageSize: "100" })) as {
    incoming_phone_numbers?: Array<{ sid: string; phone_number: string; friendly_name?: string | null }>;
  };
  const list = data.incoming_phone_numbers ?? [];
  return list.map((n) => ({
    sid: n.sid,
    phoneNumber: n.phone_number,
    friendlyName: n.friendly_name ?? null,
  }));
}

async function upsertDiscoveredNumbers(voiceChannelId: string, discovered: Array<{
  sid: string;
  phoneNumber: string;
  friendlyName?: string | null;
}>): Promise<void> {
  // Upsert by (voiceChannelId, e164) - twilioSid is filled in. Existing rows
  // not present in the discovery list are NOT deleted (preserves history) but
  // are deactivated.
  const discoveredE164s = new Set(discovered.map((n) => n.phoneNumber));
  for (const n of discovered) {
    await prisma.voiceChannelPhoneNumber.upsert({
      where: {
        voiceChannelId_e164: { voiceChannelId, e164: n.phoneNumber },
      },
      update: {
        twilioSid: n.sid,
        friendlyName: n.friendlyName ?? null,
      },
      create: {
        voiceChannelId,
        e164: n.phoneNumber,
        twilioSid: n.sid,
        friendlyName: n.friendlyName ?? null,
        isActive: false,
      },
    });
  }
  // Deactivate numbers no longer in Twilio's response (don't delete).
  await prisma.voiceChannelPhoneNumber.updateMany({
    where: {
      voiceChannelId,
      e164: { notIn: Array.from(discoveredE164s) },
    },
    data: { isActive: false },
  });
}

async function setNumberWebhooksOnTwilio(
  ctx: TwilioApiContext,
  numberSid: string,
  enable: boolean,
): Promise<void> {
  const params: Record<string, string> = enable
    ? {
        VoiceUrl: inboundVoiceWebhookUrl(),
        VoiceMethod: "POST",
        StatusCallback: inboundStatusWebhookUrl(),
        StatusCallbackMethod: "POST",
      }
    : { VoiceUrl: "", StatusCallback: "" };
  try {
    await twilioApiCall(ctx, "POST", `/IncomingPhoneNumbers/${encodeURIComponent(numberSid)}.json`, params);
  } catch (err) {
    // The number is live in Twilio but not pointed at us (or, on disable, still
    // pointed at us). Calls silently go nowhere, and nothing else in the system
    // notices because no request ever arrives.
    reportOperationalFailure({
      errorCode: ERROR_CODES.voice_number_activation_failed,
      domain: "voice", service: "conversation", provider: "twilio",
      cause: err,
      context: { enabling: enable },
    });
    throw err;
  }
}

// ─── Auth middleware (everything below is authenticated admin) ────
router.use(authenticate, resolveTenant, requireActiveTenant());

// ─── Feature-flag gate ────────────────────────────────────────
async function voiceCopilotGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.tenantId! },
      select: { voiceCopilotEnabled: true },
    });
    if (!tenant?.voiceCopilotEnabled) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    next();
  } catch (err) {
    console.error("voice-channels.gate error:", err);
    res.status(500).json({ error: "gate_check_failed" });
  }
}
router.use(voiceCopilotGate);

router.use(requireRole("ADMIN"));

// ─── GET / ──────────────────────────────────────────────────
router.get("/", async (req: Request, res: Response) => {
  try {
    const rows = await prisma.communicationChannel.findMany({
      where: { tenantId: req.tenantId!, channelType: "VOICE" },
      orderBy: { createdAt: "desc" },
      include: CHANNEL_INCLUDE,
    });
    res.json({ data: rows.map((r) => serializeChannel(r as unknown as ChannelRow)) });
  } catch (err) {
    console.error("voice-channels.list error:", err);
    res.status(500).json({ error: "failed_to_list" });
  }
});

// ─── provisionOutboundResources ─────────────────────────────
// Auto-creates an API Key + TwiML App on the customer's Twilio account using
// AccountSid+AuthToken Basic auth. Both resources are stored back on the
// voice_channels row. On partial/total failure we log a warning and mark
// config.outboundProvisioningFailed=true - the channel still works inbound.
async function provisionOutboundResources(
  channelId: string,
  voiceChannelId: string,
  accountSid: string,
  authToken: string,
): Promise<void> {
  const ctx: TwilioApiContext = { channelId, accountSid, authToken };
  const base = publicBaseUrl();

  let apiKeySid: string | null = null;
  let newApiKeySecret: string | null = null;
  let twimlAppSid: string | null = null;

  // 1. Create API Key
  try {
    const keyResp = (await twilioApiCall(ctx, "POST", "/Keys.json", {
      FriendlyName: `Gotcha Voice ${channelId}`,
    })) as { sid: string; secret: string };
    apiKeySid = keyResp.sid;
    newApiKeySecret = keyResp.secret;
  } catch (err) {
    const msg = (err as { message?: string })?.message ?? "key_create_failed";
    console.warn("voice-channels.provision: API key creation failed:", msg);
    await prisma.communicationChannel.update({
      where: { id: channelId },
      data: {
        config: { outboundProvisioningFailed: true, outboundProvisioningError: msg },
      },
    });
    return;
  }

  // 2. Create TwiML App
  try {
    const appResp = (await twilioApiCall(ctx, "POST", "/Applications.json", {
      FriendlyName: `Gotcha Voice ${channelId}`,
      VoiceUrl: `${base}/api/voice-copilot/twiml/outbound`,
      VoiceMethod: "POST",
      StatusCallback: `${base}/api/voice-copilot/twiml/outbound-status`,
      StatusCallbackMethod: "POST",
    })) as { sid: string };
    twimlAppSid = appResp.sid;
  } catch (err) {
    // Outbound calling cannot work without the TwiML App: the browser SDK has
    // nothing to connect through.
    reportOperationalFailure({
      errorCode: ERROR_CODES.voice_provisioning_failed,
      domain: "voice", service: "conversation", provider: "twilio",
      cause: err,
      context: { step: "twiml_app_create" },
    });
    const msg = (err as { message?: string })?.message ?? "app_create_failed";
    console.warn("voice-channels.provision: TwiML App creation failed:", msg);
    await prisma.communicationChannel.update({
      where: { id: channelId },
      data: {
        config: { outboundProvisioningFailed: true, outboundProvisioningError: msg },
      },
    });
    return;
  }

  // 3. Re-encrypt secrets to include new apiKeySecret, then persist both SIDs.
  try {
    // Read current encrypted blob to preserve authToken.
    const ch = await prisma.communicationChannel.findUnique({
      where: { id: channelId },
      select: { encryptedSecrets: true },
    });
    const existing = ch?.encryptedSecrets
      ? (decryptCredentials(Buffer.from(ch.encryptedSecrets).toString("utf8")) as ByoCredentials)
      : { authToken };
    const updatedSecrets = encryptCredentials({
      authToken: existing.authToken ?? authToken,
      apiKeySecret: newApiKeySecret,
    });
    await prisma.communicationChannel.update({
      where: { id: channelId },
      data: { encryptedSecrets: Buffer.from(updatedSecrets, "utf8") },
    });
    await prisma.voiceChannel.update({
      where: { id: voiceChannelId },
      data: { apiKeySid, twimlAppSid },
    });
  } catch (err) {
    const msg = (err as { message?: string })?.message ?? "persist_failed";
    console.warn("voice-channels.provision: failed to persist provisioned resources:", msg);
  }
}

// ─── POST / ─────────────────────────────────────────────────
// Create a BYO channel. The server uses the just-provided credentials to
// list `incomingPhoneNumbers` from Twilio and persists each as a child
// `VoiceChannelPhoneNumber` row (isActive=false). Admin activates a number
// in step 3 of the wizard via /numbers/:numberId/activate.
// apiKeySid / apiKeySecret / twimlAppSid are now auto-provisioned - legacy
// clients may still send them, but they are ignored.
router.post(
  "/",
  // Voice is a paid capability and a counted resource. Both gates are
  // server-side; the wizard hiding itself is presentation only.
  requireEntitlement("voice.call_pilot"),
  // VoiceChannel hangs off CommunicationChannel, which is where tenantId lives.
  requireCapacity("limit:voice_channels", (tenantId) =>
    prisma.communicationChannel.count({ where: { tenantId, channelType: "VOICE" } }),
  ),
  async (req: Request, res: Response) => {
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const friendlyName = String(body.friendlyName ?? "").trim();
    const accountSid = String(body.accountSid ?? "").trim();
    const authToken = String(body.authToken ?? "").trim();

    if (!friendlyName || !accountSid || !authToken) {
      res.status(400).json({ error: "missing_required_fields" });
      return;
    }

    const encryptedSecrets = encryptCredentials({ authToken, apiKeySecret: null });
    const webhookSecret = crypto.randomBytes(32).toString("hex");

    const created = await prisma.$transaction(async (tx) => {
      const ch = await tx.communicationChannel.create({
        data: {
          tenantId: req.tenantId!,
          channelType: "VOICE",
          provider: "twilio",
          authType: "BYO",
          friendlyName,
          status: "PENDING",
          capabilities: { inbound: true, outbound: true, mediaStream: true },
          config: {},
          encryptedSecrets: Buffer.from(encryptedSecrets, "utf8"),
          webhookSecret,
        },
      });
      const vc = await tx.voiceChannel.create({
        data: {
          communicationChannelId: ch.id,
          accountSid,
          apiKeySid: null,
          twimlAppSid: null,
        },
      });
      return { channelId: ch.id, voiceChannelId: vc.id };
    });

    // Auto-provision API Key + TwiML App (best-effort - failures are logged
    // and surfaced via config.outboundProvisioningFailed; inbound still works).
    try {
      await provisionOutboundResources(
        created.channelId,
        created.voiceChannelId,
        accountSid,
        authToken,
      );
    } catch (provErr) {
      console.warn("voice-channels.create: provisionOutboundResources threw:", provErr);
    }

    // Discover numbers from Twilio. If this fails, leave the channel in
    // ERROR so admin can retry - DO NOT delete the channel.
    try {
      const numbers = await listIncomingPhoneNumbers({
        channelId: created.channelId,
        accountSid,
        authToken,
      });
      await upsertDiscoveredNumbers(created.voiceChannelId, numbers);
      await prisma.communicationChannel.update({
        where: { id: created.channelId },
        data: { status: "ACTIVE" },
      });
      const fresh = await prisma.communicationChannel.findUnique({
        where: { id: created.channelId },
        include: CHANNEL_INCLUDE,
      });
      res.status(201).json({ data: serializeChannel(fresh as unknown as ChannelRow) });
    } catch (twErr) {
      const msg = (twErr as { message?: string })?.message ?? "twilio_error";
      await prisma.communicationChannel.update({
        where: { id: created.channelId },
        data: { status: "ERROR", healthStatus: msg, healthCheckedAt: new Date() },
      });
      console.error("voice-channels.create: twilio discovery failed:", msg);
      res.status(502).json({ error: "twilio_discovery_failed", message: msg, channelId: created.channelId });
    }
  } catch (err) {
    console.error("voice-channels.create error:", err);
    res.status(500).json({ error: "failed_to_create" });
  }
});

// ─── PATCH /:id ─────────────────────────────────────────────
// ─── GET /:id ─────────────────────────────────────────────────
// Fetch a single channel with its numbers - used by the detail page.
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const row = await prisma.communicationChannel.findUnique({
      where: { id },
      include: CHANNEL_INCLUDE,
    });
    if (!row || row.tenantId !== req.tenantId! || row.channelType !== "VOICE") {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ data: serializeChannel(row as unknown as ChannelRow) });
  } catch (err) {
    console.error("voice-channels.get error:", err);
    res.status(500).json({ error: "failed_to_load" });
  }
});

router.patch("/:id", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const existing = await prisma.communicationChannel.findUnique({ where: { id } });
    if (!existing || existing.tenantId !== req.tenantId! || existing.channelType !== "VOICE") {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const data: { friendlyName?: string; status?: "ACTIVE" | "DISABLED" } = {};
    if (typeof body.friendlyName === "string" && body.friendlyName.trim()) {
      data.friendlyName = body.friendlyName.trim();
    }
    if (body.status !== undefined) {
      const s = String(body.status).toUpperCase();
      if (s !== "ACTIVE" && s !== "DISABLED") {
        res.status(400).json({ error: "invalid_status" });
        return;
      }
      data.status = s;
    }
    if (Object.keys(data).length === 0) {
      res.status(400).json({ error: "no_fields_to_update" });
      return;
    }
    const updated = await prisma.communicationChannel.update({
      where: { id },
      data,
      include: CHANNEL_INCLUDE,
    });
    res.json({ data: serializeChannel(updated as unknown as ChannelRow) });
  } catch (err) {
    console.error("voice-channels.patch error:", err);
    res.status(500).json({ error: "failed_to_update" });
  }
});

// ─── GET /:id/copilot-config ────────────────────────────────
// Returns the per-channel Live Call Copilot config (language, persona,
// goals, required questions, data collection fields). Empty `{}` means
// "use platform defaults".
router.get("/:id/copilot-config", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const channel = await prisma.communicationChannel.findUnique({
      where: { id },
      include: { voiceChannel: true },
    });
    if (!channel || channel.tenantId !== req.tenantId! || channel.channelType !== "VOICE") {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ data: channel.voiceChannel?.copilotConfig ?? {} });
  } catch (err) {
    console.error("voice-channels.copilot-config.get error:", err);
    res.status(500).json({ error: "failed_to_load" });
  }
});

// ─── PUT /:id/copilot-config ────────────────────────────────
// Replaces the per-channel copilot config. Validated against
// CopilotConfigSchema before persistence. Returns the persisted config.
router.put("/:id/copilot-config", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const channel = await prisma.communicationChannel.findUnique({
      where: { id },
      include: { voiceChannel: true },
    });
    if (!channel || channel.tenantId !== req.tenantId! || channel.channelType !== "VOICE") {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (!channel.voiceChannel) {
      res.status(409).json({ error: "voice_channel_not_initialized" });
      return;
    }

    const parsed = CopilotConfigSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_config",
        details: parsed.error.flatten(),
      });
      return;
    }

    // Phase 6: `aiAgentId` is no longer part of the JSONB blob - it has its
    // own FK column on `voice_channels` written via PUT /:id/ai-agent. Strip
    // it here so a stale client can't reintroduce the dual-source-of-truth.
    const { aiAgentId: _ignoredAiAgentId, ...persistable } = parsed.data;

    const updated = await prisma.voiceChannel.update({
      where: { id: channel.voiceChannel.id },
      data: { copilotConfig: persistable as object },
      select: { copilotConfig: true, aiAgentId: true },
    });
    // Surface the FK in the response so the client stays in sync without a
    // second round-trip to GET /:id/ai-agent.
    res.json({
      data: { ...(updated.copilotConfig as object), aiAgentId: updated.aiAgentId },
    });
  } catch (err) {
    console.error("voice-channels.copilot-config.put error:", err);
    res.status(500).json({ error: "failed_to_update" });
  }
});

// ─── GET /:id/ai-agent ──────────────────────────────────────
// Returns { aiAgentId } - the AI Employee bound to this voice channel.
// Phase 6 moved this off `copilot_config.aiAgentId` (JSONB) onto a real
// FK column. Empty body when nothing is configured; the live runner then
// falls back to the legacy per-channel copilot config (until Phase 7
// retires that path entirely).
router.get("/:id/ai-agent", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const channel = await prisma.communicationChannel.findUnique({
      where: { id },
      include: { voiceChannel: { select: { aiAgentId: true } } },
    });
    if (!channel || channel.tenantId !== req.tenantId! || channel.channelType !== "VOICE") {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ data: { aiAgentId: channel.voiceChannel?.aiAgentId ?? null } });
  } catch (err) {
    console.error("voice-channels.ai-agent.get error:", err);
    res.status(500).json({ error: "failed_to_load" });
  }
});

// ─── PUT /:id/ai-agent ──────────────────────────────────────
// Body: { aiAgentId: string | null }. Validates the agent belongs to the
// same tenant before writing - never trust the id from the client. Pass
// null/"" to detach the channel from any AI Employee (falls back to legacy
// channel config for the duration of Phase 6).
router.put("/:id/ai-agent", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const channel = await prisma.communicationChannel.findUnique({
      where: { id },
      include: { voiceChannel: true },
    });
    if (!channel || channel.tenantId !== req.tenantId! || channel.channelType !== "VOICE") {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (!channel.voiceChannel) {
      res.status(409).json({ error: "voice_channel_not_initialized" });
      return;
    }

    const body = (req.body || {}) as Record<string, unknown>;
    const raw = body.aiAgentId;
    const aiAgentId: string | null =
      typeof raw === "string" && raw.length > 0 ? raw : null;

    if (aiAgentId) {
      const agent = await prisma.aIAgent.findUnique({
        where: { id: aiAgentId },
        select: { tenantId: true },
      });
      if (!agent || agent.tenantId !== req.tenantId!) {
        res.status(400).json({ error: "invalid_ai_agent" });
        return;
      }
    }

    const updated = await prisma.voiceChannel.update({
      where: { id: channel.voiceChannel.id },
      data: { aiAgentId },
      select: { aiAgentId: true },
    });
    res.json({ data: { aiAgentId: updated.aiAgentId } });
  } catch (err) {
    console.error("voice-channels.ai-agent.put error:", err);
    res.status(500).json({ error: "failed_to_update" });
  }
});

// ─── GET /:id/funnel ────────────────────────────────────────
// Returns { funnelId } - the per-channel pipeline funnel override. Stored
// inside the copilot_config JSONB blob today (`copilot_config.funnelId`);
// Phase 7 will promote this to a real FK column. Null/empty means
// "fall back to the department-scoped funnel resolution".
router.get("/:id/funnel", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const channel = await prisma.communicationChannel.findUnique({
      where: { id },
      include: { voiceChannel: { select: { copilotConfig: true } } },
    });
    if (!channel || channel.tenantId !== req.tenantId! || channel.channelType !== "VOICE") {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const cfg = (channel.voiceChannel?.copilotConfig ?? {}) as Record<string, unknown>;
    const funnelId = typeof cfg.funnelId === "string" && cfg.funnelId.length > 0
      ? cfg.funnelId
      : null;
    res.json({ data: { funnelId } });
  } catch (err) {
    console.error("voice-channels.funnel.get error:", err);
    res.status(500).json({ error: "failed_to_load" });
  }
});

// ─── PUT /:id/funnel ────────────────────────────────────────
// Body: { funnelId: string | null }. Validates the funnel belongs to the
// same tenant before writing. Pass null/"" to clear the override so the
// channel falls back to the department-scoped funnel.
router.put("/:id/funnel", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const channel = await prisma.communicationChannel.findUnique({
      where: { id },
      include: { voiceChannel: true },
    });
    if (!channel || channel.tenantId !== req.tenantId! || channel.channelType !== "VOICE") {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (!channel.voiceChannel) {
      res.status(409).json({ error: "voice_channel_not_initialized" });
      return;
    }

    const body = (req.body || {}) as Record<string, unknown>;
    const raw = body.funnelId;
    const funnelId: string | null =
      typeof raw === "string" && raw.length > 0 ? raw : null;

    if (funnelId) {
      const funnel = await prisma.tenantFunnel.findUnique({
        where: { id: funnelId },
        select: { tenantId: true },
      });
      if (!funnel || funnel.tenantId !== req.tenantId!) {
        res.status(400).json({ error: "invalid_funnel" });
        return;
      }
    }

    // Merge into the existing JSONB blob - never overwrite other legacy
    // fields (persona/goals/etc.) that might still carry transitional data.
    const existing = (channel.voiceChannel.copilotConfig ?? {}) as Record<string, unknown>;
    const next: Record<string, unknown> = { ...existing };
    if (funnelId) next.funnelId = funnelId;
    else delete next.funnelId;

    const updated = await prisma.voiceChannel.update({
      where: { id: channel.voiceChannel.id },
      data: { copilotConfig: next as object },
      select: { copilotConfig: true },
    });
    const stored = (updated.copilotConfig ?? {}) as Record<string, unknown>;
    res.json({
      data: { funnelId: typeof stored.funnelId === "string" ? stored.funnelId : null },
    });
  } catch (err) {
    console.error("voice-channels.funnel.put error:", err);
    res.status(500).json({ error: "failed_to_update" });
  }
});

// ─── GET /:id/routing ───────────────────────────────────────
// Per-channel inbound routing: defaultAgentId, fallbackDepartmentId,
// ringTimeoutSeconds. Returns null IDs when nothing is configured.
router.get("/:id/routing", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const ch = await prisma.communicationChannel.findUnique({
      where: { id },
      include: { voiceChannel: true },
    });
    if (!ch || ch.tenantId !== req.tenantId! || ch.channelType !== "VOICE") {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const vc = ch.voiceChannel;
    res.json({
      data: {
        defaultAgentId: vc?.defaultAgentId ?? null,
        fallbackDepartmentId: vc?.fallbackDepartmentId ?? null,
        ringTimeoutSeconds: vc?.ringTimeoutSeconds ?? 20,
        autoHangupSeconds: vc?.autoHangupSeconds ?? null,
        inboundMode: vc?.inboundMode ?? "IN_PLATFORM",
        outboundMode: vc?.outboundMode ?? "IN_PLATFORM",
        agentFirstAgentId: vc?.agentFirstAgentId ?? null,
        openWorkspaceOnAgentFirst: vc?.openWorkspaceOnAgentFirst ?? true,
      },
    });
  } catch (err) {
    console.error("voice-channels.routing.get error:", err);
    res.status(500).json({ error: "failed_to_load" });
  }
});

// ─── PUT /:id/routing ───────────────────────────────────────
// Validates IDs belong to the tenant before persisting so a channel can
// never point at someone else's user / department.
router.put("/:id/routing", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const ch = await prisma.communicationChannel.findUnique({
      where: { id },
      include: { voiceChannel: true },
    });
    if (!ch || ch.tenantId !== req.tenantId! || ch.channelType !== "VOICE") {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (!ch.voiceChannel) {
      res.status(409).json({ error: "voice_channel_not_initialized" });
      return;
    }

    const body = (req.body || {}) as Record<string, unknown>;
    const defaultAgentId =
      typeof body.defaultAgentId === "string" && body.defaultAgentId.length > 0
        ? body.defaultAgentId
        : null;
    const agentFirstAgentId =
      typeof body.agentFirstAgentId === "string" && body.agentFirstAgentId.length > 0
        ? body.agentFirstAgentId
        : null;
    const fallbackDepartmentId =
      typeof body.fallbackDepartmentId === "string" && body.fallbackDepartmentId.length > 0
        ? body.fallbackDepartmentId
        : null;
    const ringTimeoutRaw = Number(body.ringTimeoutSeconds);
    const ringTimeoutSeconds =
      Number.isFinite(ringTimeoutRaw) && ringTimeoutRaw >= 5 && ringTimeoutRaw <= 120
        ? Math.round(ringTimeoutRaw)
        : 20;
    // null = no auto-hangup (legacy behavior). Accept literal null,
    // missing field, and clamp out-of-range numbers to null.
    const autoHangupSeconds: number | null = (() => {
      if (body.autoHangupSeconds === null) return null;
      const n = Number(body.autoHangupSeconds);
      if (!Number.isFinite(n)) return null;
      if (n < 10 || n > 120) return null;
      return Math.round(n);
    })();

    const inboundMode: "IN_PLATFORM" | "FORWARD_TO_AGENT" =
      body.inboundMode === "FORWARD_TO_AGENT" ? "FORWARD_TO_AGENT" : "IN_PLATFORM";
    const outboundMode: "IN_PLATFORM" | "AGENT_FIRST" =
      body.outboundMode === "AGENT_FIRST" ? "AGENT_FIRST" : "IN_PLATFORM";
    // Default-true: when body doesn't carry the field at all (older
    // clients) we preserve the existing value so toggling other fields
    // doesn't accidentally turn this off.
    const openWorkspaceOnAgentFirst: boolean =
      typeof body.openWorkspaceOnAgentFirst === "boolean"
        ? body.openWorkspaceOnAgentFirst
        : ch.voiceChannel.openWorkspaceOnAgentFirst;

    // Tenant-isolation guards - never trust the IDs from the body.
    if (defaultAgentId) {
      const u = await prisma.user.findUnique({
        where: { id: defaultAgentId },
        select: { tenantId: true },
      });
      if (!u || u.tenantId !== req.tenantId!) {
        res.status(400).json({ error: "invalid_default_agent" });
        return;
      }
    }
    if (agentFirstAgentId) {
      const u = await prisma.user.findUnique({
        where: { id: agentFirstAgentId },
        select: { tenantId: true },
      });
      if (!u || u.tenantId !== req.tenantId!) {
        res.status(400).json({ error: "invalid_agent_first_agent" });
        return;
      }
    }
    if (fallbackDepartmentId) {
      const d = await prisma.department.findUnique({
        where: { id: fallbackDepartmentId },
        select: { tenantId: true },
      });
      if (!d || d.tenantId !== req.tenantId!) {
        res.status(400).json({ error: "invalid_fallback_department" });
        return;
      }
    }

    const updated = await prisma.voiceChannel.update({
      where: { id: ch.voiceChannel.id },
      data: {
        defaultAgentId,
        agentFirstAgentId,
        fallbackDepartmentId,
        ringTimeoutSeconds,
        autoHangupSeconds,
        inboundMode,
        outboundMode,
        openWorkspaceOnAgentFirst,
      },
      select: {
        defaultAgentId: true,
        agentFirstAgentId: true,
        fallbackDepartmentId: true,
        ringTimeoutSeconds: true,
        autoHangupSeconds: true,
        inboundMode: true,
        outboundMode: true,
        openWorkspaceOnAgentFirst: true,
      },
    });

    // When both modes are set so the missed-call → WABA template flow
    // can fire, make sure the template is registered with the tenant's
    // WABA exactly once. Fire-and-forget so a Graph API hiccup doesn't
    // fail the routing save - the ensure-template endpoint is itself
    // idempotent (checks existence first).
    const wantsTemplate = inboundMode === "FORWARD_TO_AGENT" && outboundMode === "AGENT_FIRST";
    const previouslyWanted =
      ch.voiceChannel.inboundMode === "FORWARD_TO_AGENT" &&
      ch.voiceChannel.outboundMode === "AGENT_FIRST";
    if (wantsTemplate && !previouslyWanted) {
      const url = process.env.VOICE_COPILOT_URL || "http://voice-copilot:4007";
      const key = getInternalServiceKey();
      fetch(`${url}/api/voice-copilot/callbacks/ensure-template`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Key": key },
        body: JSON.stringify({ tenantId: req.tenantId! }),
      })
        .then(async (r) => {
          if (!r.ok) {
            const txt = await r.text().catch(() => "");
            console.warn(`[voice-channels] ensure-template upstream ${r.status} ${txt.slice(0, 200)}`);
          }
        })
        .catch((err) => {
          console.warn(`[voice-channels] ensure-template upstream threw: ${err?.message}`);
        });
    }

    res.json({ data: updated });
  } catch (err) {
    console.error("voice-channels.routing.put error:", err);
    res.status(500).json({ error: "failed_to_update" });
  }
});

// ─── DELETE /:id (soft-disable) ─────────────────────────────
// Also deactivates every active number for the channel and best-effort
// reverts `voiceUrl` on Twilio side to empty.
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const existing = await prisma.communicationChannel.findUnique({
      where: { id },
      include: CHANNEL_INCLUDE,
    });
    if (!existing || existing.tenantId !== req.tenantId! || existing.channelType !== "VOICE") {
      res.status(404).json({ error: "not_found" });
      return;
    }

    // Decrypt creds so we can revert the webhook on each active number.
    let ctx: TwilioApiContext | null = null;
    if (existing.encryptedSecrets && existing.voiceChannel?.accountSid) {
      try {
        const creds = decryptCredentials(Buffer.from(existing.encryptedSecrets).toString("utf8")) as ByoCredentials;
        if (creds.authToken) {
          ctx = {
            channelId: existing.id,
            accountSid: existing.voiceChannel.accountSid,
            authToken: creds.authToken,
          };
        }
      } catch {
        /* fall through; can't revert webhook without creds */
      }
    }
    const activeNumbers = existing.voiceChannel?.phoneNumbers?.filter((n) => n.isActive) ?? [];

    await prisma.communicationChannel.update({
      where: { id },
      data: { status: "DISABLED" },
    });
    await prisma.voiceChannelPhoneNumber.updateMany({
      where: { voiceChannelId: existing.voiceChannel?.id ?? "" },
      data: { isActive: false },
    });

    // Best-effort revert on Twilio side. We don't block the response.
    if (ctx) {
      for (const n of activeNumbers) {
        if (!n.twilioSid) continue;
        try {
          await setNumberWebhooksOnTwilio(ctx, n.twilioSid, false);
        } catch (err) {
          console.warn("voice-channels.delete: failed to revert webhook for", n.e164, err);
        }
      }
    }

    res.json({ data: { id, status: "DISABLED" } });
  } catch (err) {
    console.error("voice-channels.delete error:", err);
    res.status(500).json({ error: "failed_to_disable" });
  }
});

// ─── GET /:id/numbers ───────────────────────────────────────
router.get("/:id/numbers", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const ch = await prisma.communicationChannel.findUnique({
      where: { id },
      include: CHANNEL_INCLUDE,
    });
    if (!ch || ch.tenantId !== req.tenantId! || ch.channelType !== "VOICE") {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const numbers = (ch as unknown as ChannelRow).voiceChannel?.phoneNumbers ?? [];
    res.json({ data: numbers.map(serializePhoneNumber) });
  } catch (err) {
    console.error("voice-channels.numbers.list error:", err);
    res.status(500).json({ error: "failed_to_list_numbers" });
  }
});

// Helper: build a TwilioApiContext from a channel row, decrypting creds
// inline. Returns either the context or a tagged error suitable for the
// HTTP handler.
function buildContextFromChannel(
  ch: ChannelRow,
): { ctx: TwilioApiContext } | { error: string; status: number } {
  if (!ch.encryptedSecrets || !ch.voiceChannel || !ch.voiceChannel.accountSid) {
    return { error: "channel_not_configured", status: 409 };
  }
  let creds: ByoCredentials;
  try {
    creds = decryptCredentials(Buffer.from(ch.encryptedSecrets).toString("utf8")) as ByoCredentials;
  } catch {
    return { error: "decryption_failed", status: 500 };
  }
  if (!creds.authToken) return { error: "channel_missing_credentials", status: 409 };
  return {
    ctx: {
      channelId: ch.id,
      accountSid: ch.voiceChannel.accountSid,
      authToken: creds.authToken,
    },
  };
}

// ─── POST /:id/numbers/refresh ──────────────────────────────
router.post("/:id/numbers/refresh", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const ch = await prisma.communicationChannel.findUnique({
      where: { id },
      include: CHANNEL_INCLUDE,
    });
    if (!ch || ch.tenantId !== req.tenantId! || ch.channelType !== "VOICE") {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const ctxResult = buildContextFromChannel(ch as unknown as ChannelRow);
    if ("error" in ctxResult) {
      res.status(ctxResult.status).json({ error: ctxResult.error });
      return;
    }
    try {
      const numbers = await listIncomingPhoneNumbers(ctxResult.ctx);
      await upsertDiscoveredNumbers(ch.voiceChannel!.id, numbers);
      const fresh = await prisma.voiceChannelPhoneNumber.findMany({
        where: { voiceChannelId: ch.voiceChannel!.id },
        orderBy: { createdAt: "asc" },
      });
      res.json({ data: fresh.map((r) => serializePhoneNumber(r as unknown as PhoneNumberRow)) });
    } catch (err) {
      const msg = (err as { message?: string })?.message ?? "twilio_error";
      console.error("voice-channels.numbers.refresh: twilio failed:", msg);
      res.status(502).json({ error: "twilio_discovery_failed", message: msg });
    }
  } catch (err) {
    console.error("voice-channels.numbers.refresh error:", err);
    res.status(500).json({ error: "failed_to_refresh_numbers" });
  }
});

// Helper: load + authz a (channel, number) pair, returning the joined rows.
async function loadChannelNumber(
  channelId: string,
  numberId: string,
  tenantId: string,
): Promise<{ channel: ChannelRow; number: PhoneNumberRow; ctx: TwilioApiContext } | { error: string; status: number }> {
  const ch = await prisma.communicationChannel.findUnique({
    where: { id: channelId },
    include: CHANNEL_INCLUDE,
  });
  if (!ch || ch.tenantId !== tenantId || ch.channelType !== "VOICE") {
    return { error: "not_found", status: 404 };
  }
  const row = ch as unknown as ChannelRow;
  if (!row.voiceChannel) return { error: "not_found", status: 404 };
  const number = row.voiceChannel.phoneNumbers.find((n) => n.id === numberId);
  if (!number) return { error: "not_found", status: 404 };
  const ctxResult = buildContextFromChannel(row);
  if ("error" in ctxResult) return ctxResult;
  return { channel: row, number, ctx: ctxResult.ctx };
}

// ─── POST /:id/numbers/:numberId/activate ──────────────────
router.post("/:id/numbers/:numberId/activate", async (req: Request, res: Response) => {
  try {
    const result = await loadChannelNumber(
      String(req.params.id),
      String(req.params.numberId),
      req.tenantId!,
    );
    if ("error" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    const { number, ctx } = result;
    if (!number.twilioSid) {
      res.status(409).json({ error: "missing_twilio_sid" });
      return;
    }
    try {
      await setNumberWebhooksOnTwilio(ctx, number.twilioSid, true);
    } catch (err) {
      const msg = (err as { message?: string })?.message ?? "twilio_error";
      console.error("voice-channels.numbers.activate: twilio failed:", msg);
      res.status(502).json({ error: "twilio_update_failed", message: msg });
      return;
    }
    const updated = await prisma.voiceChannelPhoneNumber.update({
      where: { id: number.id },
      data: { isActive: true },
    });
    res.json({ data: serializePhoneNumber(updated as unknown as PhoneNumberRow) });
  } catch (err) {
    console.error("voice-channels.numbers.activate error:", err);
    res.status(500).json({ error: "failed_to_activate" });
  }
});

// ─── POST /:id/numbers/:numberId/deactivate ────────────────
router.post("/:id/numbers/:numberId/deactivate", async (req: Request, res: Response) => {
  try {
    const result = await loadChannelNumber(
      String(req.params.id),
      String(req.params.numberId),
      req.tenantId!,
    );
    if ("error" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    const { number, ctx } = result;
    const updated = await prisma.voiceChannelPhoneNumber.update({
      where: { id: number.id },
      data: { isActive: false },
    });
    // Best-effort revert on Twilio side. Don't block the response on errors.
    if (number.twilioSid) {
      try {
        await setNumberWebhooksOnTwilio(ctx, number.twilioSid, false);
      } catch (err) {
        console.warn("voice-channels.numbers.deactivate: best-effort revert failed:", err);
      }
    }
    res.json({ data: serializePhoneNumber(updated as unknown as PhoneNumberRow) });
  } catch (err) {
    console.error("voice-channels.numbers.deactivate error:", err);
    res.status(500).json({ error: "failed_to_deactivate" });
  }
});

// ─── POST /:id/validate (rate-limited) ──────────────────────
router.post("/:id/validate", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const tenantId = req.tenantId!;
    const redis = getRedis();
    const rateKey = `rate:voice-channel-validate:${tenantId}`;
    const count = await redis.incr(rateKey);
    if (count === 1) {
      await redis.expire(rateKey, 60);
    }
    if (count > 10) {
      res.status(429).json({ error: "rate_limited", retryAfter: 60 });
      return;
    }

    const ch = await prisma.communicationChannel.findUnique({
      where: { id },
      include: { voiceChannel: true },
    });
    if (!ch || ch.tenantId !== tenantId || ch.channelType !== "VOICE") {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (!ch.encryptedSecrets || !ch.voiceChannel) {
      res.status(409).json({ error: "channel_not_configured" });
      return;
    }

    const accountSid = ch.voiceChannel.accountSid;
    if (!accountSid) {
      res.status(409).json({ error: "channel_missing_credentials" });
      return;
    }

    let ctxOrErr:
      | { ctx: TwilioApiContext }
      | { error: string; status: number };
    try {
      const creds = decryptCredentials(Buffer.from(ch.encryptedSecrets).toString("utf8")) as ByoCredentials;
      if (!creds.authToken) {
        ctxOrErr = { error: "channel_missing_credentials", status: 409 };
      } else {
        ctxOrErr = {
          ctx: { channelId: ch.id, accountSid, authToken: creds.authToken },
        };
      }
    } catch {
      await prisma.communicationChannel.update({
        where: { id },
        data: { healthStatus: "decryption_failed", healthCheckedAt: new Date() },
      });
      res.status(500).json({ error: "decryption_failed" });
      return;
    }
    if ("error" in ctxOrErr) {
      res.status(ctxOrErr.status).json({ error: ctxOrErr.error });
      return;
    }

    const checks = { accountReachable: false };
    let lastError: string | null = null;
    try {
      // Hit the account fetch endpoint via our dispatcher.
      await twilioApiCall(ctxOrErr.ctx, "GET", `.json`);
      checks.accountReachable = true;
    } catch (e) {
      lastError = (e as { message?: string })?.message ?? "account_unreachable";
    }

    const ok = checks.accountReachable;
    await prisma.communicationChannel.update({
      where: { id },
      data: {
        healthCheckedAt: new Date(),
        healthStatus: ok ? "ok" : lastError ?? "failed",
      },
    });
    res.json({ ok, checks });
  } catch (err) {
    console.error("voice-channels.validate error:", err);
    res.status(500).json({ error: "failed_to_validate" });
  }
});

// ─── POST /:id/rotate-secrets ───────────────────────────────
router.post("/:id/rotate-secrets", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const tenantId = req.tenantId!;
    const ch = await prisma.communicationChannel.findUnique({ where: { id } });
    if (!ch || ch.tenantId !== tenantId || ch.channelType !== "VOICE") {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const authToken = body.authToken ? String(body.authToken) : "";
    const apiKeySecret = body.apiKeySecret ? String(body.apiKeySecret) : null;
    if (!authToken) {
      res.status(400).json({ error: "auth_token_required" });
      return;
    }
    const encryptedSecrets = encryptCredentials({ authToken, apiKeySecret });
    await prisma.communicationChannel.update({
      where: { id },
      data: { encryptedSecrets: Buffer.from(encryptedSecrets, "utf8") },
    });
    res.json({ data: { id, rotated: true } });
  } catch (err) {
    console.error("voice-channels.rotate-secrets error:", err);
    res.status(500).json({ error: "failed_to_rotate" });
  }
});

export default router;
