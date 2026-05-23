/**
 * POST /api/voice-copilot/sessions/:sessionId/add-participant
 *
 * Internal-only — protected by `X-Internal-Key`. Lets the conversation
 * service surface an "Add participant" button on the workspace without
 * needing per-tenant Twilio credentials.
 *
 * Body: { to: string (E.164), label?: string }
 *
 * Looks up the session → derives the Twilio conference FriendlyName
 * (outbound: `call-{conversationId}`, inbound: `inbound-{callSid}`),
 * reads the conferenceSid out of the Redis stash that
 * `/twiml/conference-status` populates on participant-join, and dials the
 * new leg into the same conference. The added participant is NOT marked
 * `endConferenceOnExit` — when they leave the call continues for the
 * agent + customer.
 */
import { Router, Request, Response } from "express";
import { prisma, getRedis, normalizePhone } from "@chatcenter/shared";
import type { Logger } from "../lib/logger";
import type { VoiceProviderResolver } from "../providers/voice-provider";
import { NoActiveVoiceChannelError } from "../providers/resolve-provider";

const DEFAULT_INTERNAL_KEY = "chatcenter-internal-2026";

export function createVoiceAddParticipantRouter(opts: {
  resolveProvider: VoiceProviderResolver;
  logger: Logger;
}): Router {
  const router = Router();
  const { resolveProvider, logger } = opts;

  router.post("/sessions/:sessionId/add-participant", async (req: Request, res: Response) => {
    const expected = process.env.INTERNAL_SERVICE_KEY || DEFAULT_INTERNAL_KEY;
    const got = req.headers["x-internal-key"];
    if (!got || got !== expected) {
      res.status(403).json({ error: "forbidden" });
      return;
    }

    const sessionId = String(req.params.sessionId || "");
    const body = (req.body || {}) as Record<string, unknown>;
    const rawTo = typeof body.to === "string" ? body.to.trim() : "";
    const label = typeof body.label === "string" && body.label.trim()
      ? body.label.trim().slice(0, 64)
      : `added-${Date.now().toString(36).slice(-6)}`;
    if (!sessionId || !rawTo) {
      res.status(400).json({ error: "sessionId_and_to_required" });
      return;
    }
    const to = normalizePhone(rawTo) || rawTo;

    const session = await prisma.voiceCallSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true, tenantId: true, conversationId: true, callSid: true,
        direction: true, state: true,
      },
    }).catch(() => null);
    if (!session) {
      res.status(404).json({ error: "session_not_found" });
      return;
    }
    // Only live conferences accept new participants. Twilio would 4xx on
    // a non-existent SID anyway; we short-circuit for a cleaner error.
    if (session.state !== "ACTIVE" && session.state !== "HOLD") {
      res.status(409).json({ error: "session_not_live", state: session.state });
      return;
    }

    // Derive the friendlyName the conference is registered under —
    // mirrors how twilio-twiml.ts builds it for outbound, and how
    // voice-incoming.ts builds it for inbound.
    const friendlyName = session.direction === "outbound"
      ? `call-${session.conversationId}`
      : `inbound-${session.callSid}`;

    const redis = getRedis();
    const metaRaw = await redis.get(`conf:${friendlyName}`).catch(() => null);
    if (!metaRaw) {
      res.status(409).json({ error: "conference_metadata_missing" });
      return;
    }
    const meta = JSON.parse(metaRaw) as { conferenceSid?: string; callerId?: string };
    if (!meta.conferenceSid) {
      res.status(409).json({ error: "conference_not_yet_started" });
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
      logger.error({ err, sessionId }, "add-participant: provider resolve failed");
      res.status(500).json({ error: "provider_resolve_failed" });
      return;
    }

    const callerId = meta.callerId || provider.callerId;
    if (!callerId) {
      res.status(409).json({ error: "no_caller_id_configured" });
      return;
    }

    // Pre-insert a VoiceSessionParticipant row so the UI can show the
    // dialing leg immediately. The conference-status webhook later
    // matches the join event back to this row by label + sets callSid +
    // joinedAt. Resolve a Contact by phone right now so the row also
    // carries CRM identity for post-call summary attribution.
    let contactId: string | null = null;
    try {
      const c = await prisma.contact.findFirst({
        where: { tenantId: session.tenantId, phone: to },
        select: { id: true, displayName: true },
      });
      contactId = c?.id ?? null;
    } catch (err) {
      logger.warn({ err, sessionId, to }, "add-participant: contact lookup failed");
    }

    let participantId: string | null = null;
    try {
      const row = await prisma.voiceSessionParticipant.create({
        data: {
          sessionId: session.id,
          role: "ADDED",
          status: "DIALING",
          label,
          phoneNumber: to,
          contactId,
        },
        select: { id: true },
      });
      participantId = row.id;
    } catch (err: any) {
      // Unique (sessionId,label) collision is the only realistic failure;
      // happens if the same label is dialed twice. Surface a clean 409.
      logger.warn({ err, sessionId, label }, "add-participant: row insert failed");
      res.status(409).json({ error: "participant_label_taken" });
      return;
    }

    try {
      await provider.dialConferenceParticipant({
        conferenceSid: meta.conferenceSid,
        from: callerId,
        to,
        label,
        // Crucially false — when the added party hangs up the call keeps
        // going for the agent + customer.
        endConferenceOnExit: false,
      });
      logger.info({ sessionId, to, label, conferenceSid: meta.conferenceSid, participantId }, "add-participant: dialed");
      res.json({ data: { id: participantId, to, label, conferenceSid: meta.conferenceSid } });
    } catch (err: any) {
      // Dial failed — mark the pre-inserted row as FAILED so the UI can
      // surface the error and stop showing a "Dialing..." spinner.
      await prisma.voiceSessionParticipant.update({
        where: { id: participantId },
        data: { status: "FAILED", leftAt: new Date(), endReason: "dial_failed" },
      }).catch(() => { /* best-effort */ });
      logger.error({ err, sessionId, to }, "add-participant: dial failed");
      res.status(502).json({ error: "dial_failed", detail: err?.message });
    }
  });

  return router;
}
