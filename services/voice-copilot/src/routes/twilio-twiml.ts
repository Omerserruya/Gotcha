/**
 * POST /api/voice-copilot/twiml/outbound
 *
 * Twilio posts here when an agent's browser places an outbound call through
 * the TwiML App. We return TwiML that (a) dials the customer with the
 * configured caller ID, (b) bridges the call into a bidirectional Media
 * Stream so voice-copilot can transcribe + analyze it.
 *
 * POST /api/voice-copilot/twiml/conference-status
 * POST /api/voice-copilot/twiml/status
 *
 * Lifecycle + call-progress webhooks from Twilio.
 *
 * All routes authenticate via the configured VoiceProvider's signature
 * validator (Twilio HMAC-SHA1 today). Provider-specific work — TwiML
 * generation, dialing the customer leg, attaching media streams — is
 * delegated to the provider resolved for the request's tenant. Phase 1
 * always resolves to the shared TwilioProvider.
 */
import express, { Router, Request, Response, NextFunction } from "express";
import twilio from "twilio";
import { getRedis, transitionVoiceCallSessionState } from "@chatcenter/shared";
import type { Logger } from "../lib/logger";
import type { VoiceProvider, VoiceProviderResolver } from "../providers/voice-provider";
import { NoActiveVoiceChannelError } from "../providers/resolve-provider";

const VoiceResponse = twilio.twiml.VoiceResponse;

export interface TwilioTwimlRouterOpts {
  resolveProvider: VoiceProviderResolver;
  publicBaseUrl: string;
  logger: Logger;
}

/**
 * Signature-verification middleware. Resolves the provider for the request's
 * tenant (when known) and asks the provider whether the signature is valid.
 * For routes where the tenant is only known after parsing the body, callers
 * pass a `tenantResolver` to extract it.
 */
function verifySignatureWith(
  resolveProvider: VoiceProviderResolver,
  tenantResolver: (req: Request) => string | undefined,
  logger: Logger,
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const tenantId = tenantResolver(req);
    if (!tenantId) {
      logger.warn({ path: req.originalUrl }, "twiml: missing tenantId on body — cannot resolve provider");
      res.status(400).json({ error: "missing_tenant" });
      return;
    }
    let provider: VoiceProvider;
    try {
      provider = await resolveProvider(tenantId);
    } catch (err) {
      if (err instanceof NoActiveVoiceChannelError) {
        logger.warn({ tenantId }, "twiml: no active voice channel for tenant");
        res.status(503).json({ error: "no_active_voice_channel" });
        return;
      }
      logger.error({ err, tenantId }, "twiml: failed to resolve voice provider");
      res.status(500).json({ error: "provider_unavailable" });
      return;
    }

    const signature = req.header("X-Twilio-Signature") || "";
    const host = req.header("X-Forwarded-Host") || req.header("Host") || req.hostname;
    const params = (req.body && typeof req.body === "object") ? req.body as Record<string, string> : {};
    // TLS may terminate upstream of nginx, so X-Forwarded-Proto can be "http"
    // while Twilio signed against "https". Pass both candidate URLs.
    const candidateUrls = ["https", "http"].map((proto) => `${proto}://${host}${req.originalUrl}`);

    const ok = provider.validateInboundSignature({ signature, candidateUrls, formParams: params });
    if (!ok) {
      logger.warn({ host, path: req.originalUrl, signature }, "Twilio signature validation failed");
      res.status(403).json({ error: "invalid_signature" });
      return;
    }
    (req as Request & { _voiceProvider?: VoiceProvider })._voiceProvider = provider;
    next();
  };
}

function providerFromReq(req: Request): VoiceProvider {
  const p = (req as Request & { _voiceProvider?: VoiceProvider })._voiceProvider;
  if (!p) throw new Error("voice provider not attached to request");
  return p;
}

export function createTwilioTwimlRouter(opts: TwilioTwimlRouterOpts): Router {
  const router = Router();
  const { resolveProvider, publicBaseUrl, logger } = opts;

  router.use(express.urlencoded({ extended: false }));

  // Tenant resolvers: where does the tenantId live in the body?
  const tenantFromBodyField = (req: Request) =>
    String((req.body as Record<string, string> | undefined)?.tenantId || "").trim() || undefined;

  // ─── Outbound: Twilio → dial + stream ─────────────────────────
  router.post(
    "/outbound",
    verifySignatureWith(resolveProvider, tenantFromBodyField, logger),
    async (req: Request, res: Response) => {
      const provider = providerFromReq(req);
      const body = (req.body || {}) as Record<string, string>;

      const tenantId = String(body.tenantId || "").trim();

      // ── Inbound-answer fast-path ─────────────────────────────────
      // When the agent's browser answers an inbound call, the frontend
      // passes joinConference=inbound-<callSid> so we skip the outbound
      // customer-dial entirely and just drop the agent into the existing
      // conference where the customer is already waiting on hold.
      const joinConference = String(body.joinConference || "").trim();
      if (joinConference) {
        const resp = new VoiceResponse();
        const dial = resp.dial({ answerOnBridge: true });
        dial.conference(
          {
            startConferenceOnEnter: true,
            endConferenceOnExit: true,
            beep: "false",
          },
          joinConference,
        );
        logger.info({ joinConference, tenantId }, "voice-copilot agent join-conference TwiML issued");
        res.type("text/xml").status(200).send(resp.toString());
        return;
      }

      const to = String(body.To || "").trim();
      const conversationId = String(body.conversationId || "").trim();
      const notes = body.notes ? String(body.notes) : "";
      // The Voice-SDK agent leg's CallSid — Twilio includes it in every
      // /outbound post. Used later to disambiguate agent vs customer on
      // participant-join (body.Caller isn't sent for conference events).
      const agentCallSid = String(body.CallSid || "").trim();

      if (!to) {
        res.type("text/xml").status(400).send(provider.generateErrorTwiml("Missing destination number."));
        return;
      }
      if (!provider.callerId) {
        logger.error("Voice provider has no caller ID configured — outbound TwiML cannot be generated");
        res.type("text/xml").status(500).send(provider.generateErrorTwiml("Outbound calling is not configured on this server."));
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
            callerId: provider.callerId,
            notes,
            agentCallSid,
            customerDialed: false,
          }),
          "EX", 1800,
        );
      } catch (err) {
        logger.error({ err, conferenceName }, "conference: failed to stash metadata");
      }

      const xml = provider.generateOutboundConferenceTwiml({
        conferenceName,
        statusCallbackUrl: `${publicBaseUrl}/api/voice-copilot/twiml/conference-status`,
        timeoutSeconds: 30,
      });

      logger.info({ to, tenantId, conversationId, conferenceName }, "voice-copilot outbound Conference TwiML issued");
      res.type("text/xml").status(200).send(xml);
    },
  );

  // ─── Conference lifecycle callback ─────────────────────────────
  // Tenant for this callback lives in the redis stash keyed by FriendlyName,
  // so we resolve meta FIRST and only then build the provider + verify
  // signature. (The signature middleware can't run upfront because Twilio
  // doesn't echo our tenantId on conference callbacks.)
  router.post(
    "/conference-status",
    async (req: Request, res: Response) => {
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
        customerNumber: string; callerId?: string; notes?: string;
        agentCallSid?: string; customerDialed?: boolean;
        // Inbound-only fields
        callSid?: string; sessionId?: string;
      };

      // Resolve provider for the stashed tenant; verify Twilio's signature
      // against the (now-known) provider's auth token.
      let provider: VoiceProvider;
      try {
        provider = await resolveProvider(meta.tenantId);
      } catch (err) {
        if (err instanceof NoActiveVoiceChannelError) {
          logger.warn({ tenantId: meta.tenantId }, "conference-status: no active voice channel");
          res.status(503).end();
          return;
        }
        logger.error({ err, tenantId: meta.tenantId }, "conference-status: failed to resolve voice provider");
        res.status(500).end();
        return;
      }

      const signature = req.header("X-Twilio-Signature") || "";
      const host = req.header("X-Forwarded-Host") || req.header("Host") || req.hostname;
      const candidateUrls = ["https", "http"].map((proto) => `${proto}://${host}${req.originalUrl}`);
      if (!provider.validateInboundSignature({ signature, candidateUrls, formParams: body })) {
        logger.warn({ host, path: req.originalUrl }, "conference-status: signature invalid");
        res.status(403).json({ error: "invalid_signature" });
        return;
      }

      const isInbound = friendlyName.startsWith("inbound-");

      try {
        if (event === "participant-join") {
          const callSid = body.CallSid;
          // Speaker attribution (body.Caller is not present on conference
          // callbacks, so we can't rely on it). Priority order:
          //   1. Twilio's ParticipantLabel (set via `label` in REST dial for
          //      the customer leg — arrives as body.ParticipantLabel).
          //   2. CallSid comparison against the stashed agent parent-leg SID.
          //   3. For inbound: the customer leg is the one that originally rang
          //      in (its SID is stashed as meta.callSid); the agent leg is
          //      anything else.
          const label = body.ParticipantLabel || "";
          let speaker: "agent" | "customer";
          if (label === "customer") speaker = "customer";
          else if (label === "agent") speaker = "agent";
          else if (meta.agentCallSid && callSid === meta.agentCallSid) speaker = "agent";
          else if (isInbound && meta.callSid && callSid === meta.callSid) speaker = "customer";
          else if (isInbound) speaker = "agent";
          else speaker = "customer";

          // Dial the customer when the agent joins — outbound conferences only.
          // Inbound conferences already have the customer waiting on hold.
          if (!isInbound && speaker === "agent" && !meta.customerDialed) {
            logger.info({ event, conferenceSid, customerNumber: meta.customerNumber }, "conference: dialing customer");
            try {
              await provider.dialConferenceParticipant({
                conferenceSid,
                from: meta.callerId!,
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

          const wsHost = new URL(publicBaseUrl).host;
          const wsUrl = `wss://${wsHost}/twilio/media-stream/${encodeURIComponent(meta.tenantId)}`;

          // Metadata via Twilio's native `parameter.N` fields — arrives as
          // `customParameters` on the WS `start` frame. URL query string was
          // being stripped somewhere between Twilio and our nginx.
          await provider.attachMediaStreamToCall({
            callSid,
            streamUrl: wsUrl,
            track: "inbound_track",
            parameters: {
              speaker,
              conversationId: meta.conversationId,
              tenantId: meta.tenantId,
              ...(isInbound ? { direction: "inbound" } : {}),
            },
          });
          logger.info({ event, conferenceSid, callSid, speaker, label: label || null, isInbound }, "conference: attached media stream to participant");
        } else if (event === "conference-end") {
          // Transition the VoiceCallSession to ENDED for inbound conferences
          // so backend state agrees with reality even when the browser misses
          // the Twilio client-side disconnect event.
          if (isInbound && meta.sessionId) {
            try {
              await transitionVoiceCallSessionState(meta.sessionId, "ENDED", { reason: "conference_ended" });
            } catch (transErr) {
              logger.warn({ err: transErr, sessionId: meta.sessionId }, "conference-end: session transition failed");
            }
          }
          await redis.del(`conf:${friendlyName}`).catch(() => { /* ignore */ });
          logger.info({ event, conferenceSid, friendlyName }, "conference: ended, metadata cleared");
        }
      } catch (err) {
        logger.error({ err, event, conferenceSid }, "conference-status: handler error");
      }

      res.status(204).end();
    },
  );

  // ─── Status callbacks ────────────────────────────────────────
  router.post(
    "/status",
    verifySignatureWith(resolveProvider, tenantFromBodyField, logger),
    (req: Request, res: Response) => {
      const body = (req.body || {}) as Record<string, string>;
      logger.info({
        callSid: body.CallSid,
        callStatus: body.CallStatus,
        from: body.From,
        to: body.To,
        duration: body.CallDuration,
      }, "voice-copilot call status");
      res.status(204).end();
    },
  );

  return router;
}
