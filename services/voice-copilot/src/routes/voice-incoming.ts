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
  TERMINAL_STATES,
  type CallState,
} from "@chatcenter/shared";
import type { Logger } from "../lib/logger";
import type { VoiceProvider } from "../providers/voice-provider";
import { NoActiveVoiceChannelError } from "../providers/resolve-provider";
import { begin as beginDedupe } from "../webhooks/dedup";
import { fireMissedTemplate } from "../lib/missed-template";
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
  // Per-channel inbound routing. When `defaultAgentId` is set the call rings
  // only that user's browser; after `ringTimeoutSeconds` the call broadcasts
  // to every member of `fallbackDepartmentId` (or, if null, to the whole
  // tenant — matching today's behavior).
  defaultAgentId: string | null;
  fallbackDepartmentId: string | null;
  ringTimeoutSeconds: number;
  // Opt-in hard cap. Null → leave the call ringing until Twilio's own
  // dial timeout or the customer hangs up; set → auto-hangup + MISSED
  // after this many seconds.
  autoHangupSeconds: number | null;
  // IN_PLATFORM (default): drop the call into the conference + ring the
  // browsers, with Live Call Copilot. FORWARD_TO_AGENT: build a TwiML
  // <Dial> directly to defaultAgentPhone (no conference, no transcription).
  inboundMode: "IN_PLATFORM" | "FORWARD_TO_AGENT";
  defaultAgentPhone: string | null;
}

interface PhoneRow {
  e164: string;
  isActive: boolean;
  voiceChannel: {
    defaultAgentId: string | null;
    fallbackDepartmentId: string | null;
    ringTimeoutSeconds: number;
    autoHangupSeconds: number | null;
    inboundMode: "IN_PLATFORM" | "FORWARD_TO_AGENT";
    defaultAgent: { phoneNumber: string | null } | null;
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
          defaultAgent: { select: { phoneNumber: true } },
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
    defaultAgentId: row.voiceChannel.defaultAgentId,
    fallbackDepartmentId: row.voiceChannel.fallbackDepartmentId,
    ringTimeoutSeconds: row.voiceChannel.ringTimeoutSeconds,
    autoHangupSeconds: row.voiceChannel.autoHangupSeconds ?? null,
    inboundMode: row.voiceChannel.inboundMode,
    defaultAgentPhone: row.voiceChannel.defaultAgent?.phoneNumber ?? null,
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

// FORWARD_TO_AGENT mode: bypass the conference and dial the agent's
// personal mobile directly. We still persist the session row for inbox
// history; the recording lives on Twilio if the channel enabled it.
function buildForwardTwiml(opts: {
  toAgent: string;
  callerId: string;
  ringTimeoutSeconds: number;
  publicBaseUrl: string;
}): string {
  const resp = new VoiceResponse();
  const dial = resp.dial({
    callerId: opts.callerId,
    timeout: Math.max(5, Math.min(60, opts.ringTimeoutSeconds)),
    answerOnBridge: true,
    action: `${opts.publicBaseUrl}/api/voice/incoming/forward-complete`,
    method: "POST",
  });
  dial.number(opts.toAgent);
  return resp.toString();
}

function rejectXml(): string {
  return new VoiceResponse().reject().toString();
}

// fireMissedTemplate moved to ../lib/missed-template so the
// twilio-twiml conference-end / participant-leave paths can share it.

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

    // 2. Smart-callback bridge: when an agent dials the business number
    //    back from their PERSONAL mobile after missing a call, we treat
    //    the inbound call as a "return-the-missed-caller" request. The
    //    most-recent MISSED inbound session for that agent (within the
    //    last 24h) supplies the customer number; we drop both into a
    //    fresh conference. If the agent has no recent missed call, we
    //    fall through to normal inbound handling.
    {
      const fromRawSmart = String(body.From || "").trim();
      const callerCandidate = fromRawSmart
        ? normalizePhone(fromRawSmart, defaultCountryCode) || fromRawSmart
        : "";
      if (callerCandidate) {
        const matchingAgent = await prisma.user.findFirst({
          where: {
            tenantId,
            phoneNumber: callerCandidate,
            role: "AGENT",
            isActive: true,
          },
          select: { id: true },
        }).catch(() => null);
        if (matchingAgent) {
          const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
          const recentMissed = await prisma.voiceCallSession.findFirst({
            where: {
              tenantId,
              direction: "inbound",
              state: "MISSED",
              startedAt: { gte: cutoff },
              OR: [
                { assignedAgentId: matchingAgent.id },
                // Channel default-agent missed calls before claim — these
                // never had assignedAgent set when the fallback fired.
                { channel: { voiceChannel: { defaultAgentId: matchingAgent.id } } },
              ],
            },
            orderBy: { startedAt: "desc" },
            select: { id: true, customerNumber: true, conversationId: true },
          }).catch(() => null);
          if (recentMissed?.customerNumber && provider.callerId) {
            try {
              const conferenceName = `smartcb-${callSid}`;
              // Twilio can retry the inbound webhook on transient errors.
              // Use upsert keyed by callSid so the bridge stays idempotent.
              //
              // Conversation handling: VoiceCallSession.conversationId is
              // UNIQUE, and the missed call already owns
              // `recentMissed.conversationId`. Reusing it would FK-violate
              // the create and silently drop us into the regular inbound
              // ring flow (which then rings the agent's phone — the very
              // phone that's calling us). Mint a fresh Conversation row
              // dedicated to this callback leg; missedSessionId in meta
              // preserves the audit link to the original missed call.
              const callbackConversation = await prisma.conversation.create({
                data: {
                  tenantId,
                  channel: "VOICE",
                  customerExternalId: recentMissed.customerNumber,
                  status: "OPEN",
                  assignedAgentId: matchingAgent.id,
                  lastMessageAt: new Date(),
                },
              });
              const session = await prisma.voiceCallSession.upsert({
                where: { callSid },
                update: {},
                create: {
                  callSid,
                  conversationId: callbackConversation.id,
                  tenantId,
                  channelId,
                  customerNumber: recentMissed.customerNumber,
                  direction: "outbound",
                  status: "in-progress",
                  state: "CONNECTING",
                  stateHistory: [{ state: "CONNECTING", at: new Date().toISOString(), reason: "smart_callback_bridge" }] as unknown as object,
                  agentId: matchingAgent.id,
                  assignedAgentId: matchingAgent.id,
                  claimedAt: new Date(),
                  meta: {
                    smartCallback: true,
                    missedSessionId: recentMissed.id,
                    missedConversationId: recentMissed.conversationId,
                  } as unknown as object,
                },
              });
              await redis.set(
                `conf:${conferenceName}`,
                JSON.stringify({
                  tenantId,
                  conversationId: callbackConversation.id,
                  customerNumber: recentMissed.customerNumber,
                  callerId: provider.callerId,
                  agentCallSid: callSid,
                  sessionId: session.id,
                  customerDialed: false,
                }),
                "EX", 1800,
              ).catch(() => { /* noop */ });
              const xml = provider.generateOutboundConferenceTwiml({
                conferenceName,
                statusCallbackUrl: `${publicBaseUrl}/api/voice-copilot/twiml/conference-status`,
                timeoutSeconds: 30,
              });
              logger.info(
                { tenantId, callSid, missedSessionId: recentMissed.id, conferenceName },
                "incoming.voice: smart-callback bridge engaged",
              );
              res.type("text/xml").status(200).send(xml);
              return;
            } catch (err) {
              logger.error({ err, tenantId, callSid }, "smart-callback: persist failed; falling back to inbound");
              // fall through to normal inbound flow
            }
          }
        }
      }
    }

    // 3. Dedupe
    let dedupe;
    try {
      dedupe = await beginDedupe(redis, `${channelId}:${callSid}:voice`);
    } catch (err) {
      logger.error({ err, channelId, callSid }, "incoming.voice: dedupe lookup failed");
      res.status(503).end();
      return;
    }
    if (dedupe.status === "complete") {
      // Idempotent retry: replay the same TwiML we built the first time.
      // For FORWARD_TO_AGENT mode we look up the cached forward target,
      // since regenerating it here would race with profile changes.
      if (resolved.inboundMode === "FORWARD_TO_AGENT" && resolved.defaultAgentPhone) {
        res.type("text/xml").status(200).send(
          buildForwardTwiml({
            toAgent: resolved.defaultAgentPhone,
            callerId: toRaw,
            ringTimeoutSeconds: resolved.ringTimeoutSeconds,
            publicBaseUrl,
          }),
        );
        return;
      }
      const conferenceName = `inbound-${callSid}`;
      res.type("text/xml").status(200).send(buildHoldTwiml(callSid, conferenceName, publicBaseUrl));
      return;
    }
    if (dedupe.status === "pending") {
      res.status(503).end();
      return;
    }

    // FORWARD_TO_AGENT branch: persist a session row so the inbox shows
    // the call, but bypass the conference and hand Twilio a TwiML <Dial>
    // straight to the agent's mobile. If we don't have a phone target,
    // we fall through to the conference path so the call doesn't drop.
    if (resolved.inboundMode === "FORWARD_TO_AGENT" && resolved.defaultAgentPhone) {
      try {
        const fromRaw = String(body.From || "").trim();
        const customerNumber = fromRaw
          ? normalizePhone(fromRaw, defaultCountryCode) || fromRaw
          : "unknown";
        const channelAccount = await prisma.channelAccount.findFirst({
          where: { tenantId, channel: "VOICE", isActive: true },
          select: { id: true },
        });
        const conversation = await prisma.conversation.create({
          data: {
            tenantId,
            channel: "VOICE",
            channelAccountId: channelAccount?.id,
            customerExternalId: customerNumber,
            status: "OPEN",
          },
        });
        // For forward calls the agent is the leg Twilio dials, so we
        // pre-attach them; UI never rings (no browser leg) but the
        // history view shows who owned the call.
        await prisma.voiceCallSession.create({
          data: {
            callSid,
            conversationId: conversation.id,
            tenantId,
            channelId,
            customerNumber,
            direction: "inbound",
            status: "ringing",
            state: "RINGING",
            stateHistory: [{ state: "RINGING", at: new Date().toISOString(), reason: "incoming_forward_to_agent" }] as unknown as object,
            assignedAgentId: resolved.defaultAgentId,
            meta: { inboundMode: "FORWARD_TO_AGENT", forwardTarget: resolved.defaultAgentPhone } as unknown as object,
          },
        });
        await dedupe.complete();
        res.type("text/xml").status(200).send(
          buildForwardTwiml({
            toAgent: resolved.defaultAgentPhone,
            callerId: toRaw,
            ringTimeoutSeconds: resolved.ringTimeoutSeconds,
            publicBaseUrl,
          }),
        );
      } catch (err) {
        logger.error({ err, tenantId, callSid }, "incoming.voice: forward persistence failed");
        try { await dedupe.fail(); } catch { /* noop */ }
        res.status(503).end();
      }
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

      // Pre-assign to the channel's default agent (if any). Frontend uses
      // `assignedAgentId` to decide whether to show the IncomingCallBanner;
      // every other agent's UI ignores the ringing event during the
      // ring-timeout window.
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
          assignedAgentId: resolved.defaultAgentId,
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

      // `routing` tells the dashboard who should hear this ring:
      //   - "agent":      only defaultAgentId rings (rest of the tenant sees
      //                   nothing until the fallback fires)
      //   - "department": every member of fallbackDepartmentId rings
      //   - "tenant":     broadcast to everyone (today's behavior — no
      //                   default agent configured)
      const initialTarget: "agent" | "tenant" = resolved.defaultAgentId ? "agent" : "tenant";
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
          routing: { target: initialTarget, agentId: resolved.defaultAgentId },
        },
      });

      // Schedule the fallback broadcast. If the default agent doesn't claim
      // within `ringTimeoutSeconds`, re-emit the ringing event with a
      // wider `routing.target` so the rest of the team can pick up.
      // In-process setTimeout — acceptable because (a) Twilio's own
      // hold-music dial timeout is 60s and (b) a crash here just degrades
      // to "the assigned agent's phone keeps ringing." The fallback is a
      // best-effort UX improvement, not a correctness invariant.
      if (resolved.defaultAgentId) {
        const sessionIdForCb = session.id;
        const fallbackTarget: "department" | "tenant" = resolved.fallbackDepartmentId
          ? "department"
          : "tenant";
        const ringMs = Math.max(5_000, resolved.ringTimeoutSeconds * 1000);
        setTimeout(() => {
          (async () => {
            const fresh = await prisma.voiceCallSession.findUnique({
              where: { id: sessionIdForCb },
              select: {
                id: true, state: true, callSid: true, conversationId: true,
                tenantId: true, direction: true, status: true, customerNumber: true,
                agentId: true, assignedAgentId: true, claimedAt: true,
                startedAt: true, answeredAt: true, channelId: true, meta: true,
              },
            });
            if (!fresh || fresh.state !== "RINGING") return; // claimed/missed/ended already
            // Reset the targeted agent so the dashboard's "is-this-for-me"
            // filter lets the rest of the team see the banner.
            await prisma.voiceCallSession.update({
              where: { id: sessionIdForCb },
              data: { assignedAgentId: null },
            });
            fresh.assignedAgentId = null;
            await publishEvent({
              event: "voice.incoming.ringing",
              tenantId,
              data: {
                session: fresh,
                sessionId: sessionIdForCb,
                conversationId: conversation.id,
                callSid,
                channelId,
                caller: { number: customerNumber },
                ringSince: fresh.startedAt?.toISOString() ?? new Date().toISOString(),
                routing: {
                  target: fallbackTarget,
                  departmentId: resolved.fallbackDepartmentId,
                },
              },
            });
            logger.info(
              { sessionId: sessionIdForCb, fallbackTarget },
              "incoming.voice: ring-timeout fallback broadcast",
            );
          })().catch((err) => {
            logger.warn({ err, sessionId: sessionIdForCb }, "incoming.voice: fallback publish failed");
          });
        }, ringMs);
      }

      // Hard ring cap. Twilio's <Dial timeout> on the inbound parent leg
      // only triggers when the conference never starts — once an agent
      // joins, hold music plays indefinitely; if no one ever joins, the
      // 60s default still leaves the call up. When the channel opts in
      // via `autoHangupSeconds`, force-terminate the leg and mark MISSED
      // so the inbox is correct even when every agent ignores the
      // broadcast. Null = opt-out (legacy "ring forever" behavior).
      if (resolved.autoHangupSeconds != null) {
        const sessionIdForTimeout = session.id;
        const sessionCallSid = session.callSid;
        // Clamp into a safe window so a misconfigured value can't outlive
        // Twilio's own call duration (~120s for unanswered legs) or fire
        // so fast that no one has a chance to claim.
        const hardCapMs = Math.min(120_000, Math.max(10_000, resolved.autoHangupSeconds * 1000));
        setTimeout(() => {
          (async () => {
            const fresh = await prisma.voiceCallSession.findUnique({
              where: { id: sessionIdForTimeout },
              select: { id: true, state: true, callSid: true },
            });
            if (!fresh || fresh.state !== "RINGING") return; // claimed/ended already
            const result = await transitionVoiceCallSessionState(sessionIdForTimeout, "MISSED", {
              fromState: "RINGING",
              reason: "ring_timeout",
            });
            if (!result.ok) {
              logger.info({ sessionId: sessionIdForTimeout, reason: result.reason }, "ring-timeout: transition skipped");
              return;
            }
            try {
              await provider.endCall({ callSid: sessionCallSid });
            } catch (err) {
              logger.warn({ err, callSid: sessionCallSid }, "ring-timeout: endCall failed");
            }
            fireMissedTemplate(sessionIdForTimeout, logger);
            logger.info({ sessionId: sessionIdForTimeout }, "incoming.voice: ring-timeout → MISSED");
          })().catch((err) => {
            logger.warn({ err, sessionId: sessionIdForTimeout }, "ring-timeout: handler threw");
          });
        }, hardCapMs);
      }

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
      const currentState: CallState = (session.state as CallState | null) ?? fromLegacyStatus(session.status);
      const target: CallState | null = (() => {
        switch (callStatus) {
          // If the parent leg ends while still RINGING (no agent ever
          // claimed → answeredAt is null), Twilio reports `completed`
          // because we already answered with <Say>+<Dial>. Surface that
          // as MISSED so the inbox is correct.
          case "completed":   return currentState === "RINGING" && !session.answeredAt ? "MISSED" : "ENDED";
          case "busy":        return currentState === "RINGING" ? "MISSED" : "ENDED";
          case "no-answer":   return "MISSED";
          case "failed":      return "FAILED";
          case "canceled":    return "MISSED";
          // `in-progress` fires on the parent leg the moment TwiML returns —
          // Twilio considers the call answered as soon as <Say> plays, even
          // though no human is on the line yet (the caller is just listening
          // to hold music inside an empty conference). Promoting RINGING →
          // ACTIVE here would auto-stamp `answeredAt` via the FSM helper and
          // permanently mark the session "as if someone picked up", breaking
          // the missed-call detection downstream. Only advance to ACTIVE
          // when the session has already moved to CONNECTING (i.e. an agent
          // claimed it via /:id/answer); otherwise ignore the event.
          case "in-progress": return currentState === "RINGING" ? null : "ACTIVE";
          case "ringing":     return "RINGING";
          default:            return null;
        }
      })();
      if (!target) {
        await dedupe.complete();
        res.status(200).end();
        return;
      }
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
      // Trigger the missed-call WABA template when the session just
      // transitioned into MISSED. /callbacks/missed-template will
      // 409 quietly if the channel isn't configured for it.
      if (target === "MISSED") {
        fireMissedTemplate(session.id, logger);
      }
      await dedupe.complete();
      res.status(200).end();
    } catch (err) {
      logger.error({ err, callSid, callStatus }, "incoming.status: handler error");
      try { await dedupe.fail(); } catch { /* noop */ }
      res.status(503).end();
    }
  });

  // ─── POST /forward-complete ────────────────────────────────────
  // Action callback on the <Dial> emitted by FORWARD_TO_AGENT mode.
  // Twilio posts DialCallStatus once the forwarded leg finishes
  // (answered, busy, no-answer, failed, canceled). We use this to
  // transition the session FSM — without it the session would stay
  // RINGING because the conference-status events never fire.
  router.post("/forward-complete", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, string>;
    const callSid = String(body.CallSid || "").trim();
    const dialStatus = String(body.DialCallStatus || "").trim().toLowerCase();
    const toRaw = String(body.To || "").trim();
    if (!callSid) {
      res.status(400).type("text/xml").send(new VoiceResponse().toString());
      return;
    }

    const resolved = await resolveChannelByTo(toRaw).catch(() => null);
    if (!resolved) {
      res.status(404).type("text/xml").send(new VoiceResponse().toString());
      return;
    }
    const { channelId, tenantId } = resolved;

    let provider: VoiceProvider;
    try {
      provider = await resolveProviderByChannelId(channelId);
    } catch (err) {
      if (err instanceof NoActiveVoiceChannelError) {
        res.status(404).type("text/xml").send(new VoiceResponse().toString());
        return;
      }
      logger.error({ err, channelId, tenantId }, "incoming.forward-complete: provider resolve failed");
      res.status(500).type("text/xml").send(new VoiceResponse().toString());
      return;
    }
    const sig = req.header("X-Twilio-Signature") || "";
    const host = req.header("X-Forwarded-Host") || req.header("Host") || req.hostname;
    const candidateUrls = ["https", "http"].map((proto) => `${proto}://${host}${req.originalUrl}`);
    if (!provider.validateInboundSignature({ signature: sig, candidateUrls, formParams: body })) {
      res.status(403).type("text/xml").send(new VoiceResponse().toString());
      return;
    }

    try {
      const session = await prisma.voiceCallSession.findUnique({ where: { callSid } });
      // Map DialCallStatus → FSM state. `answered` is the human pickup;
      // `completed` here means the dial was placed and ended (Twilio
      // closes the parent leg too once the bridged leg ends).
      const target: CallState | null = (() => {
        switch (dialStatus) {
          case "answered": return "ACTIVE";
          case "completed": return "ENDED";
          case "busy":
          case "failed": return "FAILED";
          case "no-answer":
          case "canceled": return "MISSED";
          default: return null;
        }
      })();
      if (session && target) {
        const current: CallState = (session.state as CallState | null) ?? fromLegacyStatus(session.status);
        if (current !== target) {
          await transitionVoiceCallSessionState(session.id, target, {
            reason: `forward_dial_${dialStatus}`,
          });
          if (target === "MISSED") {
            fireMissedTemplate(session.id, logger);
          }
        }
      }
    } catch (err) {
      logger.warn({ err, callSid, dialStatus }, "incoming.forward-complete: transition failed");
    }
    // Always return an empty TwiML so Twilio hangs up the parent leg.
    res.type("text/xml").status(200).send(new VoiceResponse().toString());
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
