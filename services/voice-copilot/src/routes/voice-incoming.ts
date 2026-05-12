/**
 * Inbound voice webhooks — single endpoint, channel resolved by `To`.
 *
 *   POST /api/voice/incoming/voice     — TwiML on incoming call
 *   POST /api/voice/incoming/status    — call-progress events
 *   POST /api/voice/incoming/recording — recording lifecycle
 *
 * Channel resolution (applied to all three):
 *   1. parse `body.To` (Twilio sends the destination E.164)
 *   2. `voiceChannelPhoneNumber.findUnique({ where: { e164 } })`
 *      with parent + tenant included
 *   3. if not found, or !isActive, or parent status !== ACTIVE, or
 *      tenant.voiceIncomingEnabled !== true → 404 + <Reject/>
 *   4. otherwise resolve provider, verify signature, dedupe, apply
 *      session-create / FSM transitions / recording persistence.
 *
 * Failure semantics:
 *   - 403 invalid signature   — no retry
 *   - 200 dedupe hit          — idempotent retry
 *   - 503 infra failure        — let Twilio back off + retry
 *   - 422 FSM violation        — alert; not retryable
 *   - 500 provider failure     — Twilio retries with backoff
 */
import express, { Router, Request, Response } from "express";
import twilio from "twilio";
import {
  prisma,
  normalizePhone,
  publishEvent,
  transitionVoiceCallSessionState,
  fromLegacyStatus,
  type CallState,
} from "@chatcenter/shared";
import type { Logger } from "../lib/logger";
import type { VoiceProvider } from "../providers/voice-provider";
import { NoActiveVoiceChannelError } from "../providers/resolve-provider";
import { begin as beginDedupe } from "../webhooks/dedup";
import type { Redis } from "ioredis";

const VoiceResponse = twilio.twiml.VoiceResponse;

export interface VoiceIncomingRouterOpts {
  /** Channel-keyed resolver, used after `To` → channel lookup. */
  resolveProviderByChannelId: (channelId: string) => Promise<VoiceProvider>;
  publicBaseUrl: string;
  logger: Logger;
  redis: Redis;
}

interface ResolvedChannel {
  channelId: string;
  tenantId: string;
  defaultCountryCode: string;
}

interface PhoneRow {
  e164: string;
  isActive: boolean;
  voiceChannel: {
    parent: {
      id: string;
      tenantId: string;
      status: string;
      tenant: { voiceIncomingEnabled: boolean; voiceCopilotEnabled: boolean; defaultCountryCode: string };
    };
  };
}

async function resolveChannelByTo(toRaw: string): Promise<ResolvedChannel | null> {
  if (!toRaw) return null;
  const row = (await prisma.voiceChannelPhoneNumber.findUnique({
    where: { e164: toRaw },
    include: {
      voiceChannel: {
        include: {
          parent: {
            include: {
              tenant: {
                select: { voiceIncomingEnabled: true, voiceCopilotEnabled: true, defaultCountryCode: true },
              },
            },
          },
        },
      },
    },
  })) as unknown as PhoneRow | null;
  if (!row) return null;
  if (!row.isActive) return null;
  const parent = row.voiceChannel.parent;
  if (parent.status !== "ACTIVE") return null;
  if (!parent.tenant.voiceCopilotEnabled) return null;
  if (!parent.tenant.voiceIncomingEnabled) return null;
  return {
    channelId: parent.id,
    tenantId: parent.tenantId,
    defaultCountryCode: parent.tenant.defaultCountryCode || "IL",
  };
}

function buildHoldTwiml(_sessionId: string, conferenceName: string, publicBaseUrl: string): string {
  const resp = new VoiceResponse();
  resp.say({ voice: "Polly.Joanna" }, "Please hold while we connect you.");
  const dial = resp.dial({ timeout: 60, answerOnBridge: true });
  dial.conference(
    {
      startConferenceOnEnter: false,
      endConferenceOnExit: true,
      beep: "false",
      // No waitUrl — let Twilio use its own default hold music. The legacy
      // S3 URL was HTTP-only and intermittently fails the URL fetch.
      statusCallback: `${publicBaseUrl}/api/voice-copilot/twiml/conference-status`,
      statusCallbackEvent: ["start", "end", "join", "leave"] as any[],
      statusCallbackMethod: "POST",
    },
    conferenceName,
  );
  return resp.toString();
}

function rejectXml(): string {
  return new VoiceResponse().reject().toString();
}

export function createVoiceIncomingRouter(opts: VoiceIncomingRouterOpts): Router {
  const router = Router();
  const { resolveProviderByChannelId, publicBaseUrl, logger, redis } = opts;

  router.use(express.urlencoded({ extended: false }));

  // ─── POST /voice ───────────────────────────────────────────────
  router.post("/voice", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, string>;
    const callSid = String(body.CallSid || "").trim();
    const toRaw = String(body.To || "").trim();
    if (!callSid) {
      res.status(400).type("text/xml").send(rejectXml());
      return;
    }

    let resolved: ResolvedChannel | null;
    try {
      resolved = await resolveChannelByTo(toRaw);
    } catch (err) {
      logger.error({ err, to: toRaw }, "incoming.voice: channel lookup failed");
      res.status(503).end();
      return;
    }
    if (!resolved) {
      res.status(404).type("text/xml").send(rejectXml());
      return;
    }
    const { channelId, tenantId, defaultCountryCode } = resolved;

    // 1. Signature verification.
    let provider: VoiceProvider;
    try {
      provider = await resolveProviderByChannelId(channelId);
    } catch (err) {
      if (err instanceof NoActiveVoiceChannelError) {
        res.status(404).type("text/xml").send(rejectXml());
        return;
      }
      logger.error({ err, channelId, tenantId }, "incoming.voice: provider resolve failed");
      res.status(500).end();
      return;
    }
    const sig = req.header("X-Twilio-Signature") || "";
    const host = req.header("X-Forwarded-Host") || req.header("Host") || req.hostname;
    const candidateUrls = ["https", "http"].map((proto) => `${proto}://${host}${req.originalUrl}`);
    if (!provider.validateInboundSignature({ signature: sig, candidateUrls, formParams: body })) {
      logger.warn({ tenantId, channelId, sig }, "incoming.voice: signature invalid");
      res.status(403).end();
      return;
    }

    // 2. Dedupe
    let dedupe;
    try {
      dedupe = await beginDedupe(redis, `${channelId}:${callSid}:voice`);
    } catch (err) {
      logger.error({ err, channelId, callSid }, "incoming.voice: dedupe lookup failed");
      res.status(503).end();
      return;
    }
    if (dedupe.status === "complete") {
      const conferenceName = `inbound-${callSid}`;
      res.type("text/xml").status(200).send(buildHoldTwiml(callSid, conferenceName, publicBaseUrl));
      return;
    }
    if (dedupe.status === "pending") {
      res.status(503).end();
      return;
    }

    try {
      const fromRaw = String(body.From || "").trim();
      const customerNumber = fromRaw
        ? normalizePhone(fromRaw, defaultCountryCode) || fromRaw
        : "unknown";

      const channelAccount = await prisma.channelAccount.findFirst({
        where: { tenantId, channel: "VOICE", isActive: true },
        select: { id: true },
      });
      const conversation = await prisma.conversation.upsert({
        where: {
          id: `voice-inbound-placeholder-${callSid}`,
        },
        update: {},
        create: {
          id: `voice-inbound-${callSid}`,
          tenantId,
          channel: "VOICE",
          channelAccountId: channelAccount?.id,
          customerExternalId: customerNumber,
          status: "OPEN",
        },
      }).catch(async () => {
        return prisma.conversation.create({
          data: {
            tenantId,
            channel: "VOICE",
            channelAccountId: channelAccount?.id,
            customerExternalId: customerNumber,
            status: "OPEN",
          },
        });
      });

      const session = await prisma.voiceCallSession.create({
        data: {
          callSid,
          conversationId: conversation.id,
          tenantId,
          channelId,
          customerNumber,
          direction: "inbound",
          status: "ringing",
          state: "RINGING",
          stateHistory: [{ state: "RINGING", at: new Date().toISOString(), reason: "incoming_webhook" }] as unknown as object,
        },
      });

      // Refetch the full row so the event payload matches the shape that
      // GET /api/voice-sessions/active returns (VoiceCallSession columns).
      const sessionRow = await prisma.voiceCallSession.findUnique({
        where: { id: session.id },
        select: {
          id: true, callSid: true, conversationId: true, tenantId: true,
          direction: true, state: true, status: true, customerNumber: true,
          agentId: true, assignedAgentId: true, claimedAt: true,
          startedAt: true, answeredAt: true, channelId: true, meta: true,
        },
      });

      await publishEvent({
        event: "voice.incoming.ringing",
        tenantId,
        data: {
          // Full row — consumed by VoiceSessionsContext ringingHandler.
          session: sessionRow,
          // Backward-compat fields for any other consumers.
          sessionId: session.id,
          conversationId: conversation.id,
          callSid,
          channelId,
          caller: { number: customerNumber },
          ringSince: session.startedAt.toISOString(),
        },
      });

      // Stash conference metadata to Redis so the conference-status handler
      // can attach Media Streams for transcription (same shape as outbound).
      const conferenceName = `inbound-${callSid}`;
      try {
        await redis.set(
          `conf:${conferenceName}`,
          JSON.stringify({
            tenantId,
            conversationId: conversation.id,
            callSid,
            sessionId: session.id,
            customerNumber,
            customerDialed: false,
          }),
          "EX", 1800,
        );
      } catch (redisErr) {
        logger.error({ err: redisErr, conferenceName }, "incoming.voice: failed to stash conference metadata");
      }

      await dedupe.complete();

      res.type("text/xml").status(200).send(buildHoldTwiml(session.id, conferenceName, publicBaseUrl));
    } catch (err) {
      logger.error({ err, tenantId, callSid }, "incoming.voice: persistence failed");
      try { await dedupe.fail(); } catch { /* noop */ }
      res.status(503).end();
    }
  });

  // ─── POST /status ──────────────────────────────────────────────
  router.post("/status", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, string>;
    const callSid = String(body.CallSid || "").trim();
    const callStatus = String(body.CallStatus || "").trim();
    const toRaw = String(body.To || "").trim();
    if (!callSid) {
      res.status(400).end();
      return;
    }

    const resolved = await resolveChannelByTo(toRaw).catch(() => null);
    if (!resolved) {
      res.status(404).end();
      return;
    }
    const { channelId, tenantId } = resolved;

    let provider: VoiceProvider;
    try {
      provider = await resolveProviderByChannelId(channelId);
    } catch (err) {
      if (err instanceof NoActiveVoiceChannelError) {
        res.status(404).end();
        return;
      }
      logger.error({ err, channelId, tenantId }, "incoming.status: provider resolve failed");
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

    let dedupe;
    try {
      dedupe = await beginDedupe(redis, `${channelId}:${callSid}:status:${callStatus}`);
    } catch (err) {
      logger.error({ err }, "incoming.status: dedupe failed");
      res.status(503).end();
      return;
    }
    if (dedupe.status === "complete") { res.status(200).end(); return; }
    if (dedupe.status === "pending")  { res.status(503).end(); return; }

    try {
      const session = await prisma.voiceCallSession.findUnique({ where: { callSid } });
      if (!session) {
        await dedupe.complete();
        res.status(200).end();
        return;
      }
      const target: CallState | null = (() => {
        switch (callStatus) {
          case "completed":   return "ENDED";
          case "busy":        return "ENDED";
          case "no-answer":   return "MISSED";
          case "failed":      return "FAILED";
          case "canceled":    return "MISSED";
          case "in-progress": return "ACTIVE";
          case "ringing":     return "RINGING";
          default:            return null;
        }
      })();
      if (!target) {
        await dedupe.complete();
        res.status(200).end();
        return;
      }
      const currentState: CallState = (session.state as CallState | null) ?? fromLegacyStatus(session.status);
      if (currentState === target) {
        await dedupe.complete();
        res.status(200).end();
        return;
      }
      const result = await transitionVoiceCallSessionState(session.id, target, { reason: `twilio_status_${callStatus}` });
      if (!result.ok) {
        if (result.reason === "invalid_transition") {
          logger.warn({ from: result.from, to: result.to, callSid }, "incoming.status: FSM violation");
          await dedupe.complete();
          res.status(422).end();
          return;
        }
        if (result.reason === "stale_state") {
          await dedupe.complete();
          res.status(200).end();
          return;
        }
        throw new Error(`unexpected transition failure: ${result.reason}`);
      }
      await dedupe.complete();
      res.status(200).end();
    } catch (err) {
      logger.error({ err, callSid, callStatus }, "incoming.status: handler error");
      try { await dedupe.fail(); } catch { /* noop */ }
      res.status(503).end();
    }
  });

  // ─── POST /recording ───────────────────────────────────────────
  router.post("/recording", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, string>;
    const callSid = String(body.CallSid || "").trim();
    const recordingUrl = String(body.RecordingUrl || "").trim();
    const recordingStatus = String(body.RecordingStatus || "").trim();
    const toRaw = String(body.To || "").trim();

    const resolved = await resolveChannelByTo(toRaw).catch(() => null);
    if (!resolved) {
      res.status(404).end();
      return;
    }
    const { channelId, tenantId } = resolved;

    let provider: VoiceProvider;
    try {
      provider = await resolveProviderByChannelId(channelId);
    } catch (err) {
      if (err instanceof NoActiveVoiceChannelError) {
        res.status(404).end();
        return;
      }
      logger.error({ err, channelId, tenantId }, "incoming.recording: provider resolve failed");
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

    let dedupe;
    try {
      dedupe = await beginDedupe(redis, `${channelId}:${callSid}:recording:${recordingStatus}`);
    } catch { res.status(503).end(); return; }
    if (dedupe.status === "complete") { res.status(200).end(); return; }
    if (dedupe.status === "pending")  { res.status(503).end(); return; }

    try {
      await prisma.voiceCallSession.updateMany({
        where: { callSid },
        data: { recordingUrl: recordingUrl || null, recordingStatus: recordingStatus || null },
      });
      await dedupe.complete();
      res.status(200).end();
    } catch (err) {
      logger.error({ err, callSid }, "incoming.recording: persist failed");
      try { await dedupe.fail(); } catch { /* noop */ }
      res.status(503).end();
    }
  });

  return router;
}
