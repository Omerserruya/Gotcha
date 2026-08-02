/**
 * Server-initiated callback flow (AGENT_FIRST outbound + missed-call
 * return + WhatsApp pre-signed URL all funnel through here).
 *
 *   POST /api/voice-copilot/callbacks/initiate   (internal, X-Internal-Key)
 *     Body: { channelId, customerNumber, agentId?, conversationId?, label? }
 *     Effect: Twilio REST-dials the channel's defaultAgent's
 *             phoneNumber. When the agent answers, Twilio fetches
 *             `/twiml/callback-bridge` which returns conference TwiML;
 *             the existing conference-status handler then dials the
 *             customer and bridges them in.
 *
 *   POST /api/voice-copilot/twiml/callback-bridge
 *     Webhook fetched by Twilio when the agent's mobile leg answers.
 *     `tenantId`, `conferenceName`, `customerNumber` arrive via query
 *     string so the signature stays valid. Returns conference TwiML.
 */
import crypto from "crypto";
import express, { Router, Request, Response } from "express";
import twilio from "twilio";
import { prisma, getRedis, normalizePhone, publishEvent, outgoingMessageQueue, decryptCredentials, verifyInternalServiceKey, getInternalServiceKey } from "@chatcenter/shared";
import type { Logger } from "../lib/logger";
import type { VoiceProvider, VoiceProviderResolver } from "../providers/voice-provider";
import { NoActiveVoiceChannelError } from "../providers/resolve-provider";

const VoiceResponse = twilio.twiml.VoiceResponse;

// HMAC secret for pre-signed callback tokens. Fail-closed: with no configured
// key, signing throws and verification always fails - never fall back to the
// historically committed default string.
function callbackTokenSecret(): string {
  const secret = getInternalServiceKey();
  if (!secret) throw new Error("INTERNAL_SERVICE_KEY not configured - cannot sign/verify callback tokens");
  return secret;
}

// ─── Pre-signed callback URL token ─────────────────────────────
// Customers receive a WhatsApp template with a button URL. Tapping the
// URL triggers the AGENT_FIRST callback on their behalf. Token shape:
//   base64url(JSON({sessionId, channelId, customerNumber, exp})) + "." + hex(hmac)
// HMAC is over the base64url payload using INTERNAL_SERVICE_KEY as the
// secret - same env var that already gates internal service-to-service
// calls. Expiry is enforced server-side (default 7 days).
const CALLBACK_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

interface CallbackTokenPayload {
  sessionId: string;
  channelId: string;
  customerNumber: string;
  exp: number;
}

function b64urlEncode(s: string): string {
  return Buffer.from(s, "utf8").toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString("utf8");
}
function signCallbackToken(payload: Omit<CallbackTokenPayload, "exp">, ttlSeconds?: number): string {
  const exp = Math.floor(Date.now() / 1000) + (ttlSeconds ?? CALLBACK_TOKEN_TTL_SECONDS);
  const full: CallbackTokenPayload = { ...payload, exp };
  const data = b64urlEncode(JSON.stringify(full));
  const sig = crypto
    .createHmac("sha256", callbackTokenSecret())
    .update(data)
    .digest("hex");
  return `${data}.${sig}`;
}
function verifyCallbackToken(token: string): CallbackTokenPayload | null {
  const idx = token.indexOf(".");
  if (idx <= 0 || idx === token.length - 1) return null;
  const data = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  // Unconfigured key -> verification always fails (fail-closed), never throws.
  let expected: string;
  try {
    expected = crypto.createHmac("sha256", callbackTokenSecret()).update(data).digest("hex");
  } catch {
    return null;
  }
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"))) return null;
  let parsed: CallbackTokenPayload;
  try {
    parsed = JSON.parse(b64urlDecode(data)) as CallbackTokenPayload;
  } catch {
    return null;
  }
  if (!parsed.sessionId || !parsed.channelId || !parsed.customerNumber || !parsed.exp) return null;
  if (parsed.exp < Math.floor(Date.now() / 1000)) return null;
  return parsed;
}

export { signCallbackToken, verifyCallbackToken };

export function createVoiceCallbackRouter(opts: {
  resolveProvider: VoiceProviderResolver;
  resolveProviderByChannelId: (channelId: string) => Promise<VoiceProvider>;
  publicBaseUrl: string;
  logger: Logger;
}): Router {
  const router = Router();
  const { resolveProvider, resolveProviderByChannelId, publicBaseUrl, logger } = opts;

  // Twilio posts the TwiML + status webhooks as application/x-www-form-urlencoded.
  // The internal `/callbacks/initiate` POST is JSON; both parsers run safely
  // (each ignores bodies of the other content-type).
  router.use(express.urlencoded({ extended: false }));

  // ─── POST /callbacks/initiate (internal) ───────────────────────
  router.post("/callbacks/initiate", async (req: Request, res: Response) => {
    try {
    if (!verifyInternalServiceKey(req.headers["x-internal-key"])) {
      res.status(403).json({ error: "forbidden" });
      return;
    }

    const body = (req.body || {}) as Record<string, unknown>;
    const channelId = String(body.channelId || "").trim();
    const rawCustomer = String(body.customerNumber || "").trim();
    const conversationIdInput = typeof body.conversationId === "string" ? body.conversationId.trim() : "";
    const agentIdOverride = typeof body.agentId === "string" ? body.agentId.trim() : "";
    const label = typeof body.label === "string" && body.label.trim()
      ? body.label.trim().slice(0, 64)
      : "callback";

    if (!channelId || !rawCustomer) {
      res.status(400).json({ error: "channelId_and_customerNumber_required" });
      return;
    }

    // Resolve channel + tenant + agent target. AGENT_FIRST has its
    // own dedicated agent slot (agentFirstAgent); it falls back to
    // defaultAgent only when not configured, for backward compat.
    const channel = await prisma.communicationChannel.findUnique({
      where: { id: channelId },
      include: {
        voiceChannel: {
          include: {
            defaultAgent:    { select: { id: true, phoneNumber: true } },
            agentFirstAgent: { select: { id: true, phoneNumber: true } },
          },
        },
        tenant: { select: { defaultCountryCode: true } },
      },
    });
    if (!channel || channel.channelType !== "VOICE" || !channel.voiceChannel) {
      res.status(404).json({ error: "channel_not_found" });
      return;
    }
    if (channel.voiceChannel.outboundMode !== "AGENT_FIRST") {
      res.status(409).json({ error: "outbound_mode_not_agent_first" });
      return;
    }

    // Agent resolution order:
    //   1. Explicit `agentId` body param (smart-callback / missed-call
    //      callback when a specific agent is returning the call).
    //   2. The channel's `agentFirstAgent` - dedicated to outbound.
    //   3. The channel's `defaultAgent` - legacy fallback so channels
    //      configured before this field existed keep working.
    let agentRow: { id: string; phoneNumber: string | null } | null =
      channel.voiceChannel.agentFirstAgent ?? channel.voiceChannel.defaultAgent;
    if (agentIdOverride && agentIdOverride !== agentRow?.id) {
      const override = await prisma.user.findFirst({
        where: { id: agentIdOverride, tenantId: channel.tenantId },
        select: { id: true, phoneNumber: true },
      });
      if (override) agentRow = override;
    }
    if (!agentRow?.phoneNumber) {
      res.status(409).json({ error: "agent_phone_not_configured" });
      return;
    }

    const country = channel.tenant?.defaultCountryCode || "IL";
    const customerNumber = normalizePhone(rawCustomer, country) || rawCustomer;

    let provider: VoiceProvider;
    try {
      provider = await resolveProviderByChannelId(channelId);
    } catch (err) {
      if (err instanceof NoActiveVoiceChannelError) {
        res.status(503).json({ error: "no_active_channel" });
        return;
      }
      logger.error({ err, channelId }, "callbacks.initiate: provider resolve failed");
      res.status(500).json({ error: "provider_resolve_failed" });
      return;
    }
    if (!provider.callerId) {
      res.status(409).json({ error: "caller_id_not_configured" });
      return;
    }

    // Reuse / create the conversation so the call shows in the inbox
    // attached to the right thread (callback from missed-calls page
    // passes conversationId; pre-signed WABA link doesn't).
    let conversationId = conversationIdInput;
    if (!conversationId) {
      const conv = await prisma.conversation.create({
        data: {
          tenantId: channel.tenantId,
          channel: "VOICE",
          customerExternalId: customerNumber,
          status: "OPEN",
        },
      });
      conversationId = conv.id;
    }

    // Pre-create the VoiceCallSession row keyed by the agent-leg CallSid
    // we'll get back from Twilio. We can't use that callSid until after
    // the REST call returns, so we update the row with it post-hoc.
    const session = await prisma.voiceCallSession.create({
      data: {
        callSid: `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        conversationId,
        tenantId: channel.tenantId,
        channelId,
        customerNumber,
        direction: "outbound",
        status: "ringing",
        state: "CONNECTING",
        stateHistory: [{ state: "CONNECTING", at: new Date().toISOString(), reason: "agent_first_initiate" }] as unknown as object,
        agentId: agentRow.id,
        assignedAgentId: agentRow.id,
        claimedAt: new Date(),
        meta: { outboundMode: "AGENT_FIRST", initiatedBy: label } as unknown as object,
      },
    });

    const conferenceName = `call-${conversationId}`;
    // Stash conference metadata exactly like /outbound does so the
    // existing conference-status handler dials the customer once the
    // agent's leg joins ("speaker=agent" path in twilio-twiml.ts).
    try {
      await getRedis().set(
        `conf:${conferenceName}`,
        JSON.stringify({
          tenantId: channel.tenantId,
          conversationId,
          customerNumber,
          callerId: provider.callerId,
          notes: "",
          // agentCallSid will be set right after Calls.create returns.
          agentCallSid: "",
          sessionId: session.id,
          customerDialed: false,
        }),
        "EX", 1800,
      );
    } catch (err) {
      logger.error({ err, conferenceName }, "callbacks.initiate: redis stash failed");
    }

    // Build the TwiML callback URL. Tenant + conference name go in the
    // query string so the bridge endpoint can verify the Twilio sig
    // (sig is computed over the full URL + params).
    const twimlUrl =
      `${publicBaseUrl}/api/voice-copilot/twiml/callback-bridge` +
      `?tenantId=${encodeURIComponent(channel.tenantId)}` +
      `&conferenceName=${encodeURIComponent(conferenceName)}`;
    const statusCallbackUrl =
      `${publicBaseUrl}/api/voice-copilot/twiml/callback-agent-status` +
      `?tenantId=${encodeURIComponent(channel.tenantId)}` +
      `&sessionId=${encodeURIComponent(session.id)}` +
      `&conferenceName=${encodeURIComponent(conferenceName)}`;

    let agentCallSid: string;
    try {
      const { callSid } = await provider.placeOutboundCall({
        to: agentRow.phoneNumber,
        from: provider.callerId,
        twimlUrl,
        statusCallbackUrl,
        timeoutSeconds: 30,
      });
      agentCallSid = callSid;
    } catch (err: any) {
      logger.error({ err, channelId, sessionId: session.id }, "callbacks.initiate: placeOutboundCall failed");
      await prisma.voiceCallSession.update({
        where: { id: session.id },
        data: { state: "FAILED", status: "failed" },
      }).catch(() => { /* noop */ });
      res.status(502).json({ error: "dial_failed", detail: err?.message });
      return;
    }

    // Promote the placeholder callSid → real one.
    try {
      await prisma.voiceCallSession.update({
        where: { id: session.id },
        data: { callSid: agentCallSid },
      });
    } catch (err) {
      logger.warn({ err, sessionId: session.id, agentCallSid }, "callbacks.initiate: callSid promotion failed");
    }
    // Update redis stash with the agent leg SID so participant-join
    // can attribute it correctly.
    try {
      const redis = getRedis();
      const raw = await redis.get(`conf:${conferenceName}`);
      if (raw) {
        const meta = JSON.parse(raw);
        meta.agentCallSid = agentCallSid;
        await redis.set(`conf:${conferenceName}`, JSON.stringify(meta), "EX", 1800);
      }
    } catch { /* noop */ }

    await publishEvent({
      event: "voice.session.created",
      tenantId: channel.tenantId,
      data: {
        sessionId: session.id,
        conversationId,
        callSid: agentCallSid,
        direction: "outbound",
      },
    });

    res.json({
      data: {
        sessionId: session.id,
        conversationId,
        agentCallSid,
        conferenceName,
      },
    });
    } catch (err: any) {
      logger.error({ err }, "callbacks.initiate: unhandled error");
      // Express 4 doesn't auto-catch async-thrown errors - without this
      // the process exits on any Prisma/IO failure inside the handler.
      if (!res.headersSent) {
        res.status(500).json({ error: "initiate_failed", detail: err?.message });
      }
    }
  });

  // ─── POST /twiml/callback-bridge ──────────────────────────────
  router.post("/twiml/callback-bridge", async (req: Request, res: Response) => {
    const tenantId = String(req.query.tenantId || "").trim();
    const conferenceName = String(req.query.conferenceName || "").trim();
    if (!tenantId || !conferenceName) {
      res.status(400).type("text/xml").send(new VoiceResponse().toString());
      return;
    }

    let provider: VoiceProvider;
    try {
      provider = await resolveProvider(tenantId);
    } catch (err) {
      if (err instanceof NoActiveVoiceChannelError) {
        res.status(404).type("text/xml").send(new VoiceResponse().toString());
        return;
      }
      logger.error({ err, tenantId }, "callback-bridge: provider resolve failed");
      res.status(500).type("text/xml").send(new VoiceResponse().toString());
      return;
    }

    // Verify Twilio signature.
    const sig = req.header("X-Twilio-Signature") || "";
    const host = req.header("X-Forwarded-Host") || req.header("Host") || req.hostname;
    const candidateUrls = ["https", "http"].map((proto) => `${proto}://${host}${req.originalUrl}`);
    const formParams = (req.body || {}) as Record<string, string>;
    if (!provider.validateInboundSignature({ signature: sig, candidateUrls, formParams })) {
      logger.warn({ tenantId }, "callback-bridge: signature invalid");
      res.status(403).type("text/xml").send(new VoiceResponse().toString());
      return;
    }

    // Build conference-join TwiML so the agent's mobile leg joins
    // the conference where conference-status will then add the customer.
    const xml = provider.generateOutboundConferenceTwiml({
      conferenceName,
      statusCallbackUrl: `${publicBaseUrl}/api/voice-copilot/twiml/conference-status`,
      timeoutSeconds: 30,
    });
    res.type("text/xml").status(200).send(xml);
  });

  // ─── POST /twiml/callback-agent-status ────────────────────────
  // Status callback for the agent's mobile leg. Lets us mark the
  // session MISSED/FAILED if the agent's phone never answered.
  router.post("/twiml/callback-agent-status", async (req: Request, res: Response) => {
    const tenantId = String(req.query.tenantId || "").trim();
    const sessionId = String(req.query.sessionId || "").trim();
    const body = (req.body || {}) as Record<string, string>;
    const callStatus = String(body.CallStatus || "").trim().toLowerCase();
    if (!tenantId || !sessionId) {
      res.status(400).end();
      return;
    }

    let provider: VoiceProvider;
    try {
      provider = await resolveProvider(tenantId);
    } catch (err) {
      if (err instanceof NoActiveVoiceChannelError) {
        res.status(404).end();
        return;
      }
      logger.error({ err, tenantId }, "callback-agent-status: provider resolve failed");
      res.status(500).end();
      return;
    }
    const sig = req.header("X-Twilio-Signature") || "";
    const host = req.header("X-Forwarded-Host") || req.header("Host") || req.hostname;
    const candidateUrls = ["https", "http"].map((proto) => `${proto}://${host}${req.originalUrl}`);
    if (!provider.validateInboundSignature({ signature: sig, candidateUrls, formParams: body })) {
      res.status(403).end();
      return;
    }

    // Only act on terminal statuses that mean "agent never picked up".
    // ACTIVE / ENDED / etc. transitions are handled by conference-status
    // once the leg joins the conference.
    if (["no-answer", "busy", "failed", "canceled"].includes(callStatus)) {
      try {
        await prisma.voiceCallSession.update({
          where: { id: sessionId },
          data: { state: callStatus === "failed" || callStatus === "busy" ? "FAILED" : "MISSED", status: callStatus },
        });
      } catch { /* noop */ }
    }
    res.status(200).end();
  });

  // ─── GET /callbacks/click/:token ──────────────────────────────
  // Public endpoint reached by the customer tapping the URL button in
  // the missed-call WhatsApp template. Verifies the signed token and
  // initiates the AGENT_FIRST callback. Returns a tiny HTML page so
  // the customer's browser shows a confirmation while we ring the
  // agent server-side.
  router.get("/callbacks/click/:token", async (req: Request, res: Response) => {
    const token = String(req.params.token || "");
    const payload = verifyCallbackToken(token);
    if (!payload) {
      res
        .status(400)
        .type("text/html")
        .send(
          "<html><body style=\"font-family: -apple-system, sans-serif; padding: 24px; text-align:center;\">" +
            "<h2>This link has expired</h2><p>Please call us back directly or open WhatsApp.</p></body></html>",
        );
      return;
    }
    // Fire-and-forget the callback initiation. The response should be
    // immediate so the customer's browser shows the confirmation page.
    (async () => {
      try {
        const channel = await prisma.communicationChannel.findUnique({
          where: { id: payload.channelId },
          include: { voiceChannel: { include: { defaultAgent: true } } },
        });
        if (!channel?.voiceChannel) return;
        if (channel.voiceChannel.outboundMode !== "AGENT_FIRST") return;
        const agentId = channel.voiceChannel.defaultAgentId;
        if (!agentId) return;
        const internalKey = getInternalServiceKey();
        await fetch(`http://localhost:${process.env.PORT || 4007}/api/voice-copilot/callbacks/initiate`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Internal-Key": internalKey },
          body: JSON.stringify({
            channelId: payload.channelId,
            customerNumber: payload.customerNumber,
            agentId,
            label: `whatsapp-callback-${payload.sessionId}`,
          }),
        }).catch((err) => logger.warn({ err }, "click: callbacks/initiate fetch failed"));
      } catch (err) {
        logger.error({ err, token: token.slice(0, 16) }, "click: async initiate threw");
      }
    })().catch(() => { /* noop */ });

    res
      .status(200)
      .type("text/html")
      .send(
        "<html><body style=\"font-family: -apple-system, sans-serif; padding: 32px; max-width: 480px; margin: 0 auto; text-align:center;\">" +
          "<h2 style=\"color:#16a34a\">Calling you back…</h2>" +
          "<p>One of our agents is being connected to your phone now. You can close this page.</p>" +
          "</body></html>",
      );
  });

  // ─── POST /callbacks/missed-template (internal) ──────────────
  // Fires the WhatsApp "X tried to reach you" template to the customer
  // of a MISSED voice session, with a URL button containing the
  // pre-signed callback link. Idempotent per sessionId (records the
  // outgoing message id under session.meta to prevent re-sends).
  router.post("/callbacks/missed-template", async (req: Request, res: Response) => {
    if (!verifyInternalServiceKey(req.headers["x-internal-key"])) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const sessionId = String((req.body as Record<string, unknown>)?.sessionId || "").trim();
    if (!sessionId) {
      res.status(400).json({ error: "sessionId_required" });
      return;
    }
    const session = await prisma.voiceCallSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true, tenantId: true, channelId: true, customerNumber: true,
        conversationId: true, meta: true, state: true, direction: true,
        assignedAgentId: true,
      },
    }).catch(() => null);
    if (!session || session.state !== "MISSED" || session.direction !== "inbound") {
      res.status(404).json({ error: "session_not_eligible" });
      return;
    }
    if (!session.channelId || !session.customerNumber) {
      res.status(409).json({ error: "session_missing_routing_data" });
      return;
    }
    // Idempotency: don't re-fire if we've already queued a template.
    const meta = (session.meta as Record<string, unknown> | null) ?? {};
    if (meta.missedTemplateMessageId) {
      res.json({ data: { messageId: meta.missedTemplateMessageId, idempotent: true } });
      return;
    }

    const channel = await prisma.communicationChannel.findUnique({
      where: { id: session.channelId },
      include: { voiceChannel: { include: { defaultAgent: { select: { id: true, phoneNumber: true, name: true } } } } },
    });
    if (!channel?.voiceChannel) {
      res.status(409).json({ error: "channel_not_found" });
      return;
    }
    // The template only makes sense when both:
    //   inboundMode = FORWARD_TO_AGENT (agent off-platform; needs nudge)
    //   outboundMode = AGENT_FIRST     (callback link can actually dial)
    if (
      channel.voiceChannel.inboundMode !== "FORWARD_TO_AGENT" ||
      channel.voiceChannel.outboundMode !== "AGENT_FIRST"
    ) {
      res.status(409).json({ error: "channel_modes_unsupported" });
      return;
    }

    // The template is sent TO THE AGENT (not the customer). It tells
    // them "<customer> tried to reach you" with a one-tap callback
    // button that rings the agent's own mobile + bridges the customer.
    // Use the channel's defaultAgent - the one the call rang first;
    // assignedAgentId can be null when the fallback broadcast wave
    // fired before the call missed.
    const agentRow = channel.voiceChannel.defaultAgent;
    if (!agentRow?.phoneNumber) {
      res.status(409).json({ error: "agent_phone_not_configured" });
      return;
    }

    // Pick the tenant's active WhatsApp channel - same convention used
    // by Broadcast. If none exists we can't send a template.
    const waChannel = await prisma.channelAccount.findFirst({
      where: { tenantId: session.tenantId, channel: "WHATSAPP", isActive: true },
      select: { id: true },
    });
    if (!waChannel) {
      res.status(409).json({ error: "no_whatsapp_channel" });
      return;
    }

    // Build the pre-signed callback token. When the agent taps the
    // button, /callbacks/click verifies the token and hits
    // /callbacks/initiate, which dials the channel's defaultAgent (this
    // same person) then bridges in the customer.
    //
    // IMPORTANT: WhatsApp URL-button parameters supply only the dynamic
    // SUFFIX that fills the template's `{{1}}` slot - the static prefix
    // (https://…/callbacks/click/) lives on the approved template. If we
    // send the full URL here, WhatsApp ends up concatenating the prefix
    // with the full URL → `…/click/https://…/click/<token>`, breaking the
    // button. The full URL is kept in `callbackUrlFull` for the audit
    // metadata only.
    const callbackToken = signCallbackToken({
      sessionId: session.id,
      channelId: session.channelId,
      customerNumber: session.customerNumber,
    });
    const callbackUrlFull =
      (process.env.PUBLIC_BASE_URL || publicBaseUrl) +
      "/api/voice-copilot/callbacks/click/" +
      callbackToken;

    // Customer label for the template body parameter - prefer the
    // Contact display name, fall back to the bare phone number.
    const customerContact = await prisma.contact.findFirst({
      where: { tenantId: session.tenantId, phone: session.customerNumber, mergedIntoId: null },
      select: { displayName: true },
    }).catch(() => null);
    const customerLabel = customerContact?.displayName?.trim() || session.customerNumber;

    // Persist a Message row so the conversation thread shows what we
    // sent. Mirrors the broadcast worker's pattern. We deliberately
    // keep this on the customer's conversation thread (the missed
    // call's) so the audit trail lives with the right customer story,
    // even though the actual WhatsApp send goes out to the agent.
    const message = await prisma.message.create({
      data: {
        tenantId: session.tenantId,
        conversationId: session.conversationId,
        direction: "OUTBOUND",
        channel: "WHATSAPP",
        body: `Notified ${agentRow.name || "agent"}: ${customerLabel} tried to reach you.`,
        messageType: "template",
        status: "PENDING",
        senderName: "System",
      },
    });

    // Approved template name lives in env so each tenant can override
    // without a code change - the WABA template approval process is
    // tenant-account-bound.
    const templateName = process.env.MISSED_CALL_TEMPLATE_NAME || "missed_call_callback";
    const templateLanguage = process.env.MISSED_CALL_TEMPLATE_LANGUAGE || "en";

    await outgoingMessageQueue.add("send", {
      tenantId: session.tenantId,
      conversationId: session.conversationId,
      channel: "WHATSAPP",
      channelAccountId: waChannel.id,
      // RECIPIENT IS THE AGENT - not the customer. The template body
      // should read "<customerLabel> tried to reach you" via {{1}}.
      recipientExternalId: agentRow.phoneNumber,
      body: "",
      messageType: "template",
      senderName: "System",
      messageId: message.id,
      templateName,
      templateLanguage,
      // Template components reference WhatsApp Cloud API shape:
      //   - one BODY variable {{1}} for the customer's display name/phone
      //   - one URL button parameter (the dynamic suffix appended to
      //     the button's base URL configured in the WABA template).
      templateComponents: [
        {
          type: "body",
          parameters: [{ type: "text", text: customerLabel }],
        },
        {
          type: "button",
          sub_type: "url",
          index: "0",
          // Token only - WABA fills the `{{1}}` slot in the template's
          // URL with this value. See callbackUrlFull comment above.
          parameters: [{ type: "text", text: callbackToken }],
        },
      ],
    }, { attempts: 3 });

    // Pin the message id back into the session meta so retries are
    // de-duped on the next /callbacks/missed-template call.
    await prisma.voiceCallSession.update({
      where: { id: session.id },
      data: { meta: { ...meta, missedTemplateMessageId: message.id, missedTemplateUrl: callbackUrlFull } as unknown as object },
    }).catch(() => { /* noop */ });

    res.json({ data: { messageId: message.id } });
  });

  // ─── POST /callbacks/ensure-template (internal) ──────────────
  // Make sure the tenant's WABA has the missed-call template approved.
  // Idempotent: checks the existing list first via Graph API and only
  // POSTs a create when the template name isn't already registered.
  // Returns { exists, created } so the caller can show the admin
  // whether anything new was submitted for review.
  router.post("/callbacks/ensure-template", async (req: Request, res: Response) => {
    if (!verifyInternalServiceKey(req.headers["x-internal-key"])) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const tenantId = String((req.body as Record<string, unknown>)?.tenantId || "").trim();
    if (!tenantId) {
      res.status(400).json({ error: "tenantId_required" });
      return;
    }

    const waChannel = await prisma.channelAccount.findFirst({
      where: { tenantId, channel: "WHATSAPP", isActive: true },
      select: { id: true, credentials: true },
    });
    if (!waChannel) {
      res.status(409).json({ error: "no_whatsapp_channel" });
      return;
    }
    let creds: Record<string, unknown>;
    try {
      creds = typeof waChannel.credentials === "string"
        ? decryptCredentials(waChannel.credentials)
        : (waChannel.credentials as Record<string, unknown>);
    } catch (err) {
      logger.error({ err }, "ensure-template: decrypt failed");
      res.status(500).json({ error: "decrypt_failed" });
      return;
    }
    const wabaId = String(creds.wabaId || "").trim();
    const accessToken = String(creds.accessToken || "").trim();
    if (!wabaId || !accessToken) {
      res.status(409).json({ error: "missing_waba_credentials" });
      return;
    }

    const templateName = process.env.MISSED_CALL_TEMPLATE_NAME || "missed_call_callback";
    const templateLanguage = process.env.MISSED_CALL_TEMPLATE_LANGUAGE || "en";
    const apiVersion = process.env.FB_API_VERSION || "v22.0";
    const graphRoot = `https://graph.facebook.com/${apiVersion}`;

    // Step 1: does it already exist?
    try {
      const listRes = await fetch(
        `${graphRoot}/${encodeURIComponent(wabaId)}/message_templates?name=${encodeURIComponent(templateName)}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (listRes.ok) {
        const json = await listRes.json() as { data?: Array<{ name?: string; status?: string; language?: string }> };
        const hit = (json.data ?? []).find(
          (t) => t.name === templateName && (!t.language || t.language === templateLanguage),
        );
        if (hit) {
          res.json({ data: { exists: true, created: false, status: hit.status || "UNKNOWN" } });
          return;
        }
      } else {
        const txt = await listRes.text().catch(() => "");
        logger.warn({ status: listRes.status, body: txt.slice(0, 200) }, "ensure-template: list failed; will attempt create");
      }
    } catch (err) {
      logger.warn({ err }, "ensure-template: list threw; will attempt create");
    }

    // Step 2: create. Approved template content is intentionally
    // generic - admins can change the BODY copy by editing it in
    // Meta Business Manager after first approval. The URL button is
    // the load-bearing part and must keep the {{1}} variable suffix
    // because we paste a fresh signed token there on each send.
    const baseUrl = (process.env.PUBLIC_BASE_URL || publicBaseUrl).replace(/\/$/, "");
    const urlTemplate = `${baseUrl}/api/voice-copilot/callbacks/click/{{1}}`;
    const exampleToken = "examplepayload.examplesignature";
    const createBody = {
      name: templateName,
      language: templateLanguage,
      category: "UTILITY",
      components: [
        {
          // Agent-facing copy: {{1}} is the customer's name/phone the
          // sender passes in templateComponents.body[].parameters[0].
          // Tap the URL button → server dials this agent's mobile, then
          // bridges the customer in once they pick up.
          type: "BODY",
          text: "{{1}} tried to reach you. Tap below to call them back - we'll ring your phone first.",
          example: { body_text: [["Omer Serruya"]] },
        },
        {
          type: "BUTTONS",
          buttons: [
            {
              type: "URL",
              text: "Call them back",
              url: urlTemplate,
              example: [`${baseUrl}/api/voice-copilot/callbacks/click/${exampleToken}`],
            },
          ],
        },
      ],
    };
    try {
      const createRes = await fetch(`${graphRoot}/${encodeURIComponent(wabaId)}/message_templates`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(createBody),
      });
      const txt = await createRes.text().catch(() => "");
      if (!createRes.ok) {
        // 409-ish "already exists" sometimes returns inside a 400 body.
        // We treat any "name already exists" response as success.
        if (/already exists/i.test(txt)) {
          res.json({ data: { exists: true, created: false, status: "ALREADY_EXISTS" } });
          return;
        }
        logger.warn({ status: createRes.status, body: txt.slice(0, 500) }, "ensure-template: create failed");
        res.status(502).json({ error: "create_failed", detail: txt.slice(0, 300) });
        return;
      }
      const json = (() => { try { return JSON.parse(txt) as { status?: string; id?: string }; } catch { return {}; } })();
      res.json({ data: { exists: false, created: true, status: json.status || "PENDING_REVIEW", templateId: json.id } });
    } catch (err: any) {
      logger.error({ err }, "ensure-template: create threw");
      res.status(502).json({ error: "create_threw", detail: err?.message });
    }
  });

  return router;
}
