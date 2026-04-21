/**
 * POST /api/voice-copilot/twiml/outbound
 *
 * Twilio posts here when an agent's browser places an outbound call through
 * the TwiML App. We return TwiML that (a) dials the customer with the
 * configured caller ID, (b) bridges the call into a bidirectional Media
 * Stream so voice-copilot can transcribe + analyze it.
 *
 * POST /api/voice-copilot/status
 *
 * Twilio posts call-progress events here (initiated, ringing, answered,
 * completed). We log them for observability.
 *
 * Both routes are authenticated via Twilio signature (HMAC-SHA1 of full URL +
 * sorted form params, keyed by TWILIO_AUTH_TOKEN).
 */
import express, { Router, Request, Response, NextFunction } from "express";
import twilio from "twilio";
import { getRedis } from "@chatcenter/shared";
import type { Env } from "../config/env";
import type { Logger } from "../lib/logger";

const VoiceResponse = twilio.twiml.VoiceResponse;

function verifyTwilioSignature(env: Env, logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!env.TWILIO_AUTH_TOKEN) {
      logger.warn("Twilio signature check skipped — TWILIO_AUTH_TOKEN empty");
      next();
      return;
    }
    const signature = req.header("X-Twilio-Signature") || "";
    const host = req.header("X-Forwarded-Host") || req.header("Host") || req.hostname;
    const params = (req.body && typeof req.body === "object") ? req.body as Record<string, string> : {};

    // TLS may terminate upstream of nginx, so X-Forwarded-Proto can be "http"
    // while Twilio signed against "https". Try both schemes before rejecting.
    const schemes = ["https", "http"];
    const ok = schemes.some((proto) => {
      const url = `${proto}://${host}${req.originalUrl}`;
      return twilio.validateRequest(env.TWILIO_AUTH_TOKEN, signature, url, params);
    });
    if (!ok) {
      logger.warn({ host, path: req.originalUrl, signature }, "Twilio signature validation failed");
      res.status(403).json({ error: "invalid_signature" });
      return;
    }
    next();
  };
}

export function createTwilioTwimlRouter(opts: { env: Env; logger: Logger }): Router {
  const router = Router();
  const { env, logger } = opts;

  router.use(express.urlencoded({ extended: false }));

  // ─── Outbound: Twilio → dial + stream ─────────────────────────
  router.post("/outbound", verifyTwilioSignature(env, logger), async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, string>;

    const to = String(body.To || "").trim();
    const tenantId = String(body.tenantId || "").trim();
    const conversationId = String(body.conversationId || "").trim();
    const notes = body.notes ? String(body.notes) : "";
    // The Voice-SDK agent leg's CallSid — Twilio includes it in every
    // /outbound post. Used later to disambiguate agent vs customer on
    // participant-join (body.Caller isn't sent for conference events).
    const agentCallSid = String(body.CallSid || "").trim();

    if (!to) {
      const errResp = new VoiceResponse();
      errResp.say("Missing destination number.");
      errResp.hangup();
      res.type("text/xml").status(400).send(errResp.toString());
      return;
    }
    if (!env.TWILIO_CALLER_ID) {
      logger.error("TWILIO_CALLER_ID not configured — outbound TwiML cannot be generated");
      const errResp = new VoiceResponse();
      errResp.say("Outbound calling is not configured on this server.");
      errResp.hangup();
      res.type("text/xml").status(500).send(errResp.toString());
      return;
    }

    // Conference architecture: both participants' audio is individually
    // forked by Twilio. Agent joins the conference via this TwiML; the
    // customer is added as a participant by the conference-status handler
    // once `conference-start` fires. Per-participant Media Streams are
    // attached via the Calls.streams REST API on `participant-join`.
    const conferenceName = conversationId
      ? `call-${conversationId}`
      : `call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Stash metadata so the status-callback handler (which has no client
    // context) can look up the customer number + conversation info.
    try {
      await getRedis().set(
        `conf:${conferenceName}`,
        JSON.stringify({
          tenantId,
          conversationId,
          customerNumber: to,
          callerId: env.TWILIO_CALLER_ID,
          notes,
          agentCallSid,
          customerDialed: false,
        }),
        "EX", 1800,
      );
    } catch (err) {
      logger.error({ err, conferenceName }, "conference: failed to stash metadata");
    }

    const resp = new VoiceResponse();
    const dial = resp.dial({ answerOnBridge: true, timeout: 30 });
    dial.conference({
      startConferenceOnEnter: true,
      endConferenceOnExit: true,
      beep: "false",
      waitUrl: "",
      statusCallback: `${env.PUBLIC_BASE_URL}/api/voice-copilot/twiml/conference-status`,
      statusCallbackEvent: ["start", "join", "leave", "end"],
      statusCallbackMethod: "POST",
    }, conferenceName);

    logger.info({ to, tenantId, conversationId, conferenceName }, "voice-copilot outbound Conference TwiML issued");
    res.type("text/xml").status(200).send(resp.toString());
  });

  // ─── Conference lifecycle callback ─────────────────────────────
  router.post("/conference-status", verifyTwilioSignature(env, logger), async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, string>;
    const event = body.StatusCallbackEvent;
    const conferenceSid = body.ConferenceSid;
    const friendlyName = body.FriendlyName;

    if (!event || !friendlyName) {
      res.status(204).end();
      return;
    }

    const redis = getRedis();
    const metaRaw = await redis.get(`conf:${friendlyName}`).catch(() => null);
    if (!metaRaw) {
      logger.warn({ event, friendlyName }, "conference-status: no stashed metadata");
      res.status(204).end();
      return;
    }
    const meta = JSON.parse(metaRaw) as {
      tenantId: string; conversationId: string;
      customerNumber: string; callerId: string; notes?: string;
      agentCallSid?: string; customerDialed?: boolean;
    };

    const twilioClient = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);

    try {
      if (event === "participant-join") {
        const callSid = body.CallSid;
        // Speaker attribution (body.Caller is not present on conference
        // callbacks, so we can't rely on it). Priority order:
        //   1. Twilio's ParticipantLabel (set via `label` in REST dial for
        //      the customer leg — arrives as body.ParticipantLabel).
        //   2. CallSid comparison against the stashed agent parent-leg SID.
        const label = body.ParticipantLabel || "";
        let speaker: "agent" | "customer";
        if (label === "customer") speaker = "customer";
        else if (label === "agent") speaker = "agent";
        else if (meta.agentCallSid && callSid === meta.agentCallSid) speaker = "agent";
        else speaker = "customer";

        // Dial the customer when the agent joins — done here instead of on
        // `conference-start` because that event can fail to fire with
        // startConferenceOnEnter (Twilio quirk), leaving the agent alone.
        if (speaker === "agent" && !meta.customerDialed) {
          logger.info({ event, conferenceSid, customerNumber: meta.customerNumber }, "conference: dialing customer");
          try {
            await twilioClient.conferences(conferenceSid).participants.create({
              from: meta.callerId,
              to: meta.customerNumber,
              label: "customer",
              endConferenceOnExit: true,
            });
            meta.customerDialed = true;
            await redis.set(`conf:${friendlyName}`, JSON.stringify(meta), "EX", 1800).catch(() => { /* ignore */ });
          } catch (dialErr) {
            logger.error({ err: dialErr, conferenceSid }, "conference: customer dial failed");
          }
        }

        const wsHost = new URL(env.PUBLIC_BASE_URL).host;
        const wsUrl = `wss://${wsHost}/twilio/media-stream/${encodeURIComponent(meta.tenantId)}`;

        // Metadata via Twilio's native `parameter.N` fields — arrives as
        // `customParameters` on the WS `start` frame. URL query string was
        // being stripped somewhere between Twilio and our nginx.
        await twilioClient.calls(callSid).streams.create({
          url: wsUrl,
          track: "inbound_track",
          "parameter1.name": "speaker",
          "parameter1.value": speaker,
          "parameter2.name": "conversationId",
          "parameter2.value": meta.conversationId,
          "parameter3.name": "tenantId",
          "parameter3.value": meta.tenantId,
        });
        logger.info({ event, conferenceSid, callSid, speaker, label: label || null }, "conference: attached media stream to participant");
      } else if (event === "conference-end") {
        await redis.del(`conf:${friendlyName}`).catch(() => { /* ignore */ });
        logger.info({ event, conferenceSid, friendlyName }, "conference: ended, metadata cleared");
      }
    } catch (err) {
      logger.error({ err, event, conferenceSid }, "conference-status: handler error");
    }

    res.status(204).end();
  });

  // ─── Status callbacks ────────────────────────────────────────
  router.post("/status", verifyTwilioSignature(env, logger), (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, string>;
    logger.info({
      callSid: body.CallSid,
      callStatus: body.CallStatus,
      from: body.From,
      to: body.To,
      duration: body.CallDuration,
    }, "voice-copilot call status");
    res.status(204).end();
  });

  return router;
}
