/**
 * Conference control endpoints - whisper / consult / cold-transfer.
 *
 * All internal-only, `X-Internal-Key` guarded. Called by the conversation
 * service after authenticating the agent.
 *
 *   POST /sessions/:id/customer-hold   { hold: boolean }
 *     Toggles "hold music" on the customer's leg without ending the
 *     conference. While held, the customer hears Twilio's hold sound and
 *     can't hear the agent + 3rd party - i.e. whisper / consult mode.
 *
 *   POST /sessions/:id/agent-leave
 *     Drops the agent's leg from the conference. Used for cold transfer
 *     after `add-participant` brought in a 3rd party: the call continues
 *     between the customer and the new party.
 *
 * Both endpoints look up the conference metadata stashed by
 * twilio-twiml.ts on participant-join (`conferenceSid` + customer leg
 * SID) and fail clean with 409 when the conference isn't live.
 */
import { Router, Request, Response } from "express";
import { prisma, getRedis, verifyInternalServiceKey } from "@chatcenter/shared";
import type { Logger } from "../lib/logger";
import type { VoiceProviderResolver } from "../providers/voice-provider";
import { NoActiveVoiceChannelError } from "../providers/resolve-provider";


interface ConferenceMeta {
  conferenceSid?: string;
  agentCallSid?: string;
  customerCallSid?: string;
  // Inbound: the customer's leg IS the original session callSid.
  callSid?: string;
}

async function loadSessionAndMeta(sessionId: string) {
  const session = await prisma.voiceCallSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true, tenantId: true, conversationId: true, callSid: true,
      direction: true, state: true,
    },
  }).catch(() => null);
  if (!session) return { error: "session_not_found" as const };

  const friendlyName = session.direction === "outbound"
    ? `call-${session.conversationId}`
    : `inbound-${session.callSid}`;
  const redis = getRedis();
  const raw = await redis.get(`conf:${friendlyName}`).catch(() => null);
  if (!raw) return { error: "conference_metadata_missing" as const };
  const meta = JSON.parse(raw) as ConferenceMeta;
  return { session, meta, friendlyName };
}

export function createVoiceConferenceControlRouter(opts: {
  resolveProvider: VoiceProviderResolver;
  logger: Logger;
}): Router {
  const router = Router();
  const { resolveProvider, logger } = opts;

  function guardInternal(req: Request, res: Response): boolean {
    if (!verifyInternalServiceKey(req.headers["x-internal-key"])) {
      res.status(403).json({ error: "forbidden" });
      return false;
    }
    return true;
  }

  router.post("/sessions/:sessionId/customer-hold", async (req: Request, res: Response) => {
    if (!guardInternal(req, res)) return;
    const sessionId = String(req.params.sessionId || "");
    const body = (req.body || {}) as Record<string, unknown>;
    const hold = Boolean(body.hold);
    if (!sessionId) {
      res.status(400).json({ error: "sessionId_required" });
      return;
    }
    const r = await loadSessionAndMeta(sessionId);
    if ("error" in r) {
      res.status(r.error === "session_not_found" ? 404 : 409).json({ error: r.error });
      return;
    }
    const { session, meta } = r;
    if (session.state !== "ACTIVE" && session.state !== "HOLD") {
      res.status(409).json({ error: "session_not_live", state: session.state });
      return;
    }
    if (!meta.conferenceSid) {
      res.status(409).json({ error: "conference_not_yet_started" });
      return;
    }
    // For outbound the customer leg is meta.customerCallSid (stashed on
    // participant-join). For inbound it's the session's original callSid.
    const customerCallSid = meta.customerCallSid
      ?? (session.direction === "inbound" ? session.callSid ?? undefined : undefined);
    if (!customerCallSid) {
      res.status(409).json({ error: "customer_leg_unknown" });
      return;
    }

    let provider;
    try {
      provider = await resolveProvider(session.tenantId);
    } catch (err) {
      if (err instanceof NoActiveVoiceChannelError) {
        res.status(503).json({ error: "no_active_channel" });
        return;
      }
      logger.error({ err, sessionId }, "customer-hold: provider resolve failed");
      res.status(500).json({ error: "provider_resolve_failed" });
      return;
    }

    try {
      await provider.setParticipantHold({
        conferenceSid: meta.conferenceSid,
        callSid: customerCallSid,
        hold,
      });
      res.json({ data: { hold, conferenceSid: meta.conferenceSid } });
    } catch (err: any) {
      logger.error({ err, sessionId, hold }, "customer-hold: provider call failed");
      res.status(502).json({ error: "hold_failed", detail: err?.message });
    }
  });

  router.post("/sessions/:sessionId/agent-leave", async (req: Request, res: Response) => {
    if (!guardInternal(req, res)) return;
    const sessionId = String(req.params.sessionId || "");
    if (!sessionId) {
      res.status(400).json({ error: "sessionId_required" });
      return;
    }
    const r = await loadSessionAndMeta(sessionId);
    if ("error" in r) {
      res.status(r.error === "session_not_found" ? 404 : 409).json({ error: r.error });
      return;
    }
    const { session, meta } = r;
    if (session.state !== "ACTIVE" && session.state !== "HOLD") {
      res.status(409).json({ error: "session_not_live", state: session.state });
      return;
    }
    // For outbound the agent leg is meta.agentCallSid. For inbound the
    // agent is whichever leg ISN'T the customer - we can derive it from
    // meta.agentCallSid (set when the inbound /twiml/outbound join arrived).
    const agentCallSid = meta.agentCallSid;
    if (!agentCallSid) {
      res.status(409).json({ error: "agent_leg_unknown" });
      return;
    }

    let provider;
    try {
      provider = await resolveProvider(session.tenantId);
    } catch (err) {
      if (err instanceof NoActiveVoiceChannelError) {
        res.status(503).json({ error: "no_active_channel" });
        return;
      }
      res.status(500).json({ error: "provider_resolve_failed" });
      return;
    }

    try {
      await provider.endCall({ callSid: agentCallSid });
      res.json({ data: { agentDropped: true } });
    } catch (err: any) {
      logger.error({ err, sessionId }, "agent-leave: endCall failed");
      res.status(502).json({ error: "leave_failed", detail: err?.message });
    }
  });

  return router;
}
