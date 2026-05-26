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
import {
  getRedis,
  prisma,
  publishEvent,
  transitionVoiceCallSessionState,
  TERMINAL_STATES,
  type CallState,
} from "@chatcenter/shared";
import type { Logger } from "../lib/logger";
import type { VoiceProvider, VoiceProviderResolver } from "../providers/voice-provider";
import { NoActiveVoiceChannelError } from "../providers/resolve-provider";
import { fireMissedTemplate } from "../lib/missed-template";

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
      const agentId = String(body.agentId || "").trim();
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

      // Create the VoiceCallSession row up-front so the unified
      // /voice/[sessionId] workspace can render the call (mirrors the
      // inbound path in voice-incoming.ts). Existing row reused if Twilio
      // retries the webhook for the same agentCallSid.
      let sessionId: string | null = null;
      if (conversationId && agentCallSid) {
        try {
          const existing = await prisma.voiceCallSession.findUnique({
            where: { callSid: agentCallSid },
            select: { id: true },
          });
          if (existing) {
            sessionId = existing.id;
          } else {
            const created = await prisma.voiceCallSession.create({
              data: {
                callSid: agentCallSid,
                conversationId,
                tenantId,
                customerNumber: to,
                direction: "outbound",
                status: "in-progress",
                state: "CONNECTING",
                stateHistory: [{ state: "CONNECTING", at: new Date().toISOString(), reason: "outbound_twiml" }] as unknown as object,
                agentId: agentId || null,
                assignedAgentId: agentId || null,
                claimedAt: agentId ? new Date() : null,
              },
            });
            sessionId = created.id;

            const sessionRow = await prisma.voiceCallSession.findUnique({
              where: { id: created.id },
              select: {
                id: true, callSid: true, conversationId: true, tenantId: true,
                direction: true, state: true, status: true, customerNumber: true,
                agentId: true, assignedAgentId: true, claimedAt: true,
                startedAt: true, answeredAt: true, channelId: true, meta: true,
              },
            });
            await publishEvent({
              event: "voice.session.created",
              tenantId,
              data: {
                session: sessionRow,
                sessionId: created.id,
                conversationId,
                callSid: agentCallSid,
              },
            });
          }
        } catch (err) {
          logger.error({ err, conversationId, agentCallSid }, "outbound: VoiceCallSession persist failed");
        }
      }

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
            sessionId,
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

      logger.info({ to, tenantId, conversationId, conferenceName, sessionId }, "voice-copilot outbound Conference TwiML issued");
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
        // Stashed on first participant-join so the add-participant REST
        // endpoint can dial the new leg into the right Twilio conference.
        conferenceSid?: string;
        // Stashed when the customer leg joins so hold/unhold can target
        // the right participant — outbound dials the customer second so
        // the callSid isn't known up-front.
        customerCallSid?: string;
      };

      // Persist the conferenceSid once we see it so the workspace's
      // "Add participant" feature has somewhere to look it up.
      if (conferenceSid && meta.conferenceSid !== conferenceSid) {
        meta.conferenceSid = conferenceSid;
        await redis.set(`conf:${friendlyName}`, JSON.stringify(meta), "EX", 1800).catch(() => { /* ignore */ });
      }

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
            // Status callback lets us detect customer-decline before the leg
            // ever joins the conference (no-answer/busy/canceled). FriendlyName
            // carries the redis lookup key for the /customer-status handler.
            const customerStatusUrl = `${publicBaseUrl}/api/voice-copilot/twiml/customer-status?friendlyName=${encodeURIComponent(friendlyName)}`;
            try {
              await provider.dialConferenceParticipant({
                conferenceSid,
                from: meta.callerId!,
                to: meta.customerNumber,
                label: "customer",
                endConferenceOnExit: true,
                statusCallbackUrl: customerStatusUrl,
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

          // The call is ACTIVE once a human-on-each-side bridge exists:
          //   • Outbound — agent leg is already CONNECTING from placement;
          //     when the customer joins the conference, both parties are
          //     bridged → ACTIVE.
          //   • Inbound  — customer joined first (hold music), session is
          //     CONNECTING after the agent clicks /answer; when the agent's
          //     browser actually joins the conference, both parties are
          //     bridged → ACTIVE. The earlier "/api/voice/incoming/status
          //     in-progress → ACTIVE" path was removed because Twilio sends
          //     `in-progress` as soon as TwiML returns (hold music = active
          //     from Twilio's POV), which would auto-stamp `answeredAt`
          //     before any human picked up and break missed-call detection.
          const triggerActive = (!isInbound && speaker === "customer") || (isInbound && speaker === "agent");
          if (triggerActive && meta.sessionId) {
            try {
              await transitionVoiceCallSessionState(meta.sessionId, "ACTIVE", {
                reason: isInbound ? "agent_joined" : "customer_joined",
              });
            } catch (transErr) {
              logger.warn({ err: transErr, sessionId: meta.sessionId }, "conference: ACTIVE transition failed");
            }
          }

          // Stash the customer's callSid so hold/unhold endpoints can
          // target the right Twilio participant. For inbound the customer
          // is meta.callSid (the original ring); for outbound it's the
          // leg labeled "customer" that we just dialed.
          if (speaker === "customer" && callSid && meta.customerCallSid !== callSid) {
            meta.customerCallSid = callSid;
            await redis.set(`conf:${friendlyName}`, JSON.stringify(meta), "EX", 1800).catch(() => { /* ignore */ });
          }

          // ─── VoiceSessionParticipant tracking ─────────────────
          // Three cases:
          //   1. label ∈ {"agent","customer"} → CUSTOMER/AGENT leg.
          //      Upsert by (sessionId, callSid).
          //   2. label set to something else → ADDED leg. The row was
          //      pre-inserted by add-participant; match it by label and
          //      attach the now-known callSid + joinedAt.
          //   3. label empty → bare leg (e.g. inbound customer that came
          //      via the original ring before our labeling existed).
          //      Treat as CUSTOMER/AGENT by callSid identity.
          if (meta.sessionId && callSid) {
            try {
              const isAddedLeg = label && label !== "agent" && label !== "customer";
              if (isAddedLeg) {
                // Attach the new callSid + JOINED status to the pre-
                // inserted row matched by (sessionId, label).
                await prisma.voiceSessionParticipant.updateMany({
                  where: {
                    sessionId: meta.sessionId,
                    label,
                    callSid: null,
                  },
                  data: {
                    callSid,
                    status: "JOINED",
                    joinedAt: new Date(),
                  },
                });
              } else {
                const role = speaker === "agent" ? "AGENT" : "CUSTOMER";
                const phoneNumber = speaker === "customer" ? meta.customerNumber : null;
                await prisma.voiceSessionParticipant.upsert({
                  where: {
                    sessionId_callSid: {
                      sessionId: meta.sessionId,
                      callSid,
                    },
                  },
                  create: {
                    sessionId: meta.sessionId,
                    role,
                    status: "JOINED",
                    callSid,
                    label: speaker, // "agent" | "customer"
                    phoneNumber,
                    joinedAt: new Date(),
                  },
                  update: {
                    status: "JOINED",
                    joinedAt: new Date(),
                  },
                });
              }
            } catch (err) {
              logger.warn({ err, sessionId: meta.sessionId, callSid, label }, "participant-join: row upsert failed");
            }
          }
        } else if (event === "participant-leave") {
          // Mark the matching row LEFT. Lookup by (sessionId, callSid) —
          // it's been stable since participant-join. Best-effort; if no
          // row matches we never tracked the leg, which is fine.
          const callSid = body.CallSid;
          if (meta.sessionId && callSid) {
            try {
              await prisma.voiceSessionParticipant.updateMany({
                where: { sessionId: meta.sessionId, callSid, leftAt: null },
                data: { status: "LEFT", leftAt: new Date(), endReason: "participant_left" },
              });
            } catch (err) {
              logger.warn({ err, sessionId: meta.sessionId, callSid }, "participant-leave: row update failed");
            }

            // Auto-close safety net: if every tracked participant has
            // now left, force-transition the session to a terminal state.
            // Twilio's own conference-end webhook normally drives this
            // when a leg with endConferenceOnExit=true leaves, but in
            // edge cases (cold transfer to added-only legs, dropped
            // status events) the conference can outlive the last real
            // speaker. If `answeredAt` is null nobody actually picked up
            // (the customer hung up while still on hold) — log as MISSED
            // so the missed-call inbox is correct.
            try {
              const remaining = await prisma.voiceSessionParticipant.count({
                where: { sessionId: meta.sessionId, leftAt: null },
              });
              if (remaining === 0) {
                const fresh = await prisma.voiceCallSession.findUnique({
                  where: { id: meta.sessionId },
                  select: { state: true, answeredAt: true },
                });
                if (fresh && !TERMINAL_STATES.has(fresh.state as CallState)) {
                  const target: CallState = fresh.answeredAt ? "ENDED" : "MISSED";
                  logger.info({ sessionId: meta.sessionId, target }, "participant-leave: no participants left, closing session");
                  await transitionVoiceCallSessionState(meta.sessionId, target, { reason: "all_participants_left" })
                    .catch((err) => logger.warn({ err, sessionId: meta.sessionId, target }, "participant-leave: transition failed"));
                  // Fire the WhatsApp callback template only on MISSED —
                  // ENDED means someone actually spoke, no nudge needed.
                  if (target === "MISSED") {
                    fireMissedTemplate(meta.sessionId, logger);
                  }
                }
              }
            } catch (err) {
              logger.warn({ err, sessionId: meta.sessionId }, "participant-leave: remaining-count check failed");
            }
          }
        } else if (event === "conference-end") {
          // Transition the VoiceCallSession to ENDED so backend state agrees
          // with reality even when the browser misses the Twilio client-side
          // disconnect event. Applies to both inbound and outbound — both
          // stash sessionId in meta now.
          //
          // Race guard: an agent decline / customer-hangup-while-ringing can
          // have set MISSED (or FAILED) just before this fires. The FSM
          // rejects MISSED→ENDED, but we read first so the "lost the race"
          // path is silent instead of logging a transition warning, and so
          // a session that never reached ACTIVE isn't incorrectly downgraded
          // to ENDED on the rare path where conference-end fires AFTER an
          // explicit terminal write.
          if (meta.sessionId) {
            try {
              const fresh = await prisma.voiceCallSession.findUnique({
                where: { id: meta.sessionId },
                select: { state: true, answeredAt: true },
              });
              if (fresh && !TERMINAL_STATES.has(fresh.state as CallState)) {
                // Conference ending without anyone ever answering means
                // nobody actually spoke to the caller — log as MISSED
                // instead of ENDED so the missed-call inbox is correct.
                const target: CallState = fresh.answeredAt ? "ENDED" : "MISSED";
                await transitionVoiceCallSessionState(meta.sessionId, target, { reason: "conference_ended" });
                // Fire the WhatsApp template only when we actually flipped
                // to MISSED here (the /status webhook handles the case
                // where Twilio reports the parent leg terminally first).
                // Idempotent — the endpoint short-circuits if already fired.
                if (target === "MISSED") {
                  fireMissedTemplate(meta.sessionId, logger);
                }
              }
            } catch (transErr) {
              logger.warn({ err: transErr, sessionId: meta.sessionId }, "conference-end: session transition failed");
            }
            // Sweep any participants still marked live and close them
            // out. Twilio sends participant-leave for each leg before
            // conference-end in the happy path, but a hard hangup can
            // leave rows stuck on status=JOINED.
            try {
              await prisma.voiceSessionParticipant.updateMany({
                where: { sessionId: meta.sessionId, leftAt: null },
                data: { status: "LEFT", leftAt: new Date(), endReason: "conference_ended" },
              });
            } catch (err) {
              logger.warn({ err, sessionId: meta.sessionId }, "conference-end: participant sweep failed");
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

  // ─── Customer-leg status callback (outbound decline detection) ─
  // Twilio POSTs here when the customer-side dial completes. The leg may
  // never have joined the conference (no-answer/busy/canceled/failed) — in
  // that case we transition the VoiceCallSession to MISSED/FAILED and hang
  // up the agent leg so the agent isn't left alone in an empty conference.
  router.post(
    "/customer-status",
    async (req: Request, res: Response) => {
      const body = (req.body || {}) as Record<string, string>;
      const callStatus = String(body.CallStatus || "").toLowerCase();
      const customerCallSid = body.CallSid;
      const friendlyName = String((req.query?.friendlyName as string) || "").trim();

      if (!friendlyName || !callStatus) {
        res.status(204).end();
        return;
      }

      const redis = getRedis();
      const metaRaw = await redis.get(`conf:${friendlyName}`).catch(() => null);
      if (!metaRaw) {
        // Meta may already be cleared by conference-end — nothing to do.
        res.status(204).end();
        return;
      }
      const meta = JSON.parse(metaRaw) as {
        tenantId: string; conversationId: string;
        customerNumber: string; callerId?: string; notes?: string;
        agentCallSid?: string; customerDialed?: boolean;
        sessionId?: string;
      };

      let provider: VoiceProvider;
      try {
        provider = await resolveProvider(meta.tenantId);
      } catch (err) {
        if (err instanceof NoActiveVoiceChannelError) {
          res.status(503).end();
          return;
        }
        logger.error({ err, tenantId: meta.tenantId }, "customer-status: failed to resolve provider");
        res.status(500).end();
        return;
      }

      const signature = req.header("X-Twilio-Signature") || "";
      const host = req.header("X-Forwarded-Host") || req.header("Host") || req.hostname;
      const candidateUrls = ["https", "http"].map((proto) => `${proto}://${host}${req.originalUrl}`);
      if (!provider.validateInboundSignature({ signature, candidateUrls, formParams: body })) {
        logger.warn({ host, path: req.originalUrl }, "customer-status: signature invalid");
        res.status(403).json({ error: "invalid_signature" });
        return;
      }

      // We only care about leg-end statuses where the customer didn't reach
      // the conference. `completed` is the normal end-of-call path and is
      // already handled by `conference-end` → ENDED; ignore it here.
      const target: "MISSED" | "FAILED" | null = (() => {
        switch (callStatus) {
          case "no-answer": return "MISSED";
          case "busy":      return "MISSED";
          case "canceled":  return "MISSED";
          case "failed":    return "FAILED";
          default:          return null;
        }
      })();
      if (!target || !meta.sessionId) {
        res.status(204).end();
        return;
      }

      try {
        const result = await transitionVoiceCallSessionState(meta.sessionId, target, {
          reason: `customer_${callStatus}`,
        });
        if (!result.ok && result.reason === "invalid_transition") {
          // Session already terminal (e.g. agent hung up first) — nothing to do.
          logger.info({ sessionId: meta.sessionId, from: result.from, to: result.to }, "customer-status: session already terminal");
        }
      } catch (transErr) {
        logger.warn({ err: transErr, sessionId: meta.sessionId, target }, "customer-status: session transition failed");
      }

      // Tell the workspace UI specifically — the generic `voice.session.state`
      // event already fires from the transition above, but a dedicated event
      // lets the page render "Customer didn't answer" vs a plain redirect.
      try {
        await publishEvent({
          event: "voice.session.declined",
          tenantId: meta.tenantId,
          data: {
            sessionId: meta.sessionId,
            conversationId: meta.conversationId,
            callSid: customerCallSid,
            reason: callStatus,
            state: target,
          },
        });
      } catch (pubErr) {
        logger.warn({ err: pubErr }, "customer-status: publishEvent failed");
      }

      // Unwind the agent's empty-conference leg. endCall is idempotent.
      if (meta.agentCallSid) {
        try {
          await provider.endCall({ callSid: meta.agentCallSid });
        } catch (endErr) {
          logger.warn({ err: endErr, callSid: meta.agentCallSid }, "customer-status: agent endCall failed");
        }
      }

      logger.info({
        sessionId: meta.sessionId,
        conversationId: meta.conversationId,
        callStatus,
        target,
      }, "customer-status: handled outbound decline");
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

  // TwiML-App-level StatusCallback registered during channel provisioning
  // (see services/conversation/src/routes/voice-channels.ts: Applications.json
  // StatusCallback URL). Twilio's payload here is the standard webhook shape
  // (CallSid, CallStatus, ApplicationSid, AccountSid, From, To...) — there
  // is no tenantId field, so the standard signature verifier can't run.
  // The endpoint is logging-only; Twilio doesn't accept commands from the
  // response, so an unverified 204 is safe and stops the 404 noise in logs.
  router.post("/outbound-status", (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, string>;
    logger.info({
      callSid: body.CallSid,
      callStatus: body.CallStatus,
      applicationSid: body.ApplicationSid,
      from: body.From,
      to: body.To,
      duration: body.CallDuration,
    }, "voice-copilot outbound app status");
    res.status(204).end();
  });

  return router;
}
