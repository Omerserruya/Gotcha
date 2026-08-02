/**
 * Per-participant control endpoints - generalizes the legacy
 * `customer-hold` + `agent-leave` routes to any leg tracked in
 * `VoiceSessionParticipant`.
 *
 *   GET  /sessions/:sessionId/participants
 *       List every participant row for the session, live + already-left.
 *
 *   POST /sessions/:sessionId/participants/:participantId/hold
 *       Body: { hold: boolean }
 *       Toggles Twilio's `hold` flag on that leg's conference participant.
 *       Whisper / consult: hold the customer while talking privately with
 *       an added 3rd party. Also works against the added leg itself when
 *       the agent wants to park the consult before bringing them back.
 *
 *   POST /sessions/:sessionId/participants/:participantId/kick
 *       Hangs up the leg. Used for "drop the 3rd party" without ending
 *       the customer-agent conversation, or as an explicit "drop the
 *       agent" for cold transfer. The conference itself only ends when
 *       a leg flagged endConferenceOnExit=true (the agent leg by
 *       convention) hangs up.
 *
 * All routes are internal-only (`X-Internal-Key`). The conversation
 * service proxies them so the browser never holds Twilio credentials.
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
  callSid?: string;
}

async function loadConferenceMeta(sessionId: string) {
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

export function createVoiceParticipantsRouter(opts: {
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

  // ─── GET /sessions/:sessionId/participants ───────────────────
  router.get("/sessions/:sessionId/participants", async (req: Request, res: Response) => {
    if (!guardInternal(req, res)) return;
    const sessionId = String(req.params.sessionId || "");
    if (!sessionId) {
      res.status(400).json({ error: "sessionId_required" });
      return;
    }
    try {
      const rows = await prisma.voiceSessionParticipant.findMany({
        where: { sessionId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          role: true,
          status: true,
          callSid: true,
          label: true,
          phoneNumber: true,
          displayName: true,
          contactId: true,
          onHold: true,
          joinedAt: true,
          leftAt: true,
          endReason: true,
          contact: {
            select: { id: true, displayName: true, phone: true, email: true, tags: true },
          },
        },
      });
      res.json({ data: rows });
    } catch (err: any) {
      logger.error({ err, sessionId }, "participants.list: failed");
      res.status(500).json({ error: "list_failed" });
    }
  });

  // ─── POST /sessions/:sessionId/participants/:participantId/hold ───
  router.post("/sessions/:sessionId/participants/:participantId/hold", async (req: Request, res: Response) => {
    if (!guardInternal(req, res)) return;
    const sessionId = String(req.params.sessionId || "");
    const participantId = String(req.params.participantId || "");
    const hold = Boolean((req.body as { hold?: unknown })?.hold);
    if (!sessionId || !participantId) {
      res.status(400).json({ error: "ids_required" });
      return;
    }

    const r = await loadConferenceMeta(sessionId);
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

    const participant = await prisma.voiceSessionParticipant.findUnique({
      where: { id: participantId },
      select: { id: true, sessionId: true, callSid: true, status: true, leftAt: true },
    });
    if (!participant || participant.sessionId !== sessionId) {
      res.status(404).json({ error: "participant_not_found" });
      return;
    }
    if (!participant.callSid) {
      res.status(409).json({ error: "participant_not_joined_yet" });
      return;
    }
    if (participant.leftAt || participant.status === "LEFT") {
      res.status(409).json({ error: "participant_already_left" });
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
      logger.error({ err, sessionId }, "participants.hold: provider resolve failed");
      res.status(500).json({ error: "provider_resolve_failed" });
      return;
    }

    try {
      await provider.setParticipantHold({
        conferenceSid: meta.conferenceSid,
        callSid: participant.callSid,
        hold,
      });
      await prisma.voiceSessionParticipant.update({
        where: { id: participantId },
        data: { onHold: hold },
      }).catch(() => { /* best-effort */ });
      res.json({ data: { id: participantId, onHold: hold } });
    } catch (err: any) {
      logger.error({ err, sessionId, participantId, hold }, "participants.hold: provider call failed");
      res.status(502).json({ error: "hold_failed", detail: err?.message });
    }
  });

  // ─── POST /sessions/:sessionId/participants/:participantId/kick ───
  router.post("/sessions/:sessionId/participants/:participantId/kick", async (req: Request, res: Response) => {
    if (!guardInternal(req, res)) return;
    const sessionId = String(req.params.sessionId || "");
    const participantId = String(req.params.participantId || "");
    if (!sessionId || !participantId) {
      res.status(400).json({ error: "ids_required" });
      return;
    }

    const r = await loadConferenceMeta(sessionId);
    if ("error" in r) {
      res.status(r.error === "session_not_found" ? 404 : 409).json({ error: r.error });
      return;
    }
    const { session } = r;
    if (session.state !== "ACTIVE" && session.state !== "HOLD") {
      res.status(409).json({ error: "session_not_live", state: session.state });
      return;
    }

    const participant = await prisma.voiceSessionParticipant.findUnique({
      where: { id: participantId },
      select: { id: true, sessionId: true, callSid: true, leftAt: true, status: true },
    });
    if (!participant || participant.sessionId !== sessionId) {
      res.status(404).json({ error: "participant_not_found" });
      return;
    }
    if (!participant.callSid) {
      res.status(409).json({ error: "participant_not_joined_yet" });
      return;
    }
    if (participant.leftAt || participant.status === "LEFT") {
      // Idempotent - already gone.
      res.json({ data: { id: participantId, kicked: true, alreadyLeft: true } });
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
      await provider.endCall({ callSid: participant.callSid });
      // The participant-leave webhook will follow and mark the row LEFT;
      // we don't pre-mark here so the natural event-driven flow stays the
      // source of truth for joinedAt/leftAt timestamps.
      res.json({ data: { id: participantId, kicked: true } });
    } catch (err: any) {
      logger.error({ err, sessionId, participantId }, "participants.kick: endCall failed");
      res.status(502).json({ error: "kick_failed", detail: err?.message });
    }
  });

  return router;
}
