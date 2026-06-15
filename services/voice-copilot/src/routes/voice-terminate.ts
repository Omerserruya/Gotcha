/**
 * POST /api/voice-copilot/sessions/:sessionId/terminate
 *
 * Internal-only - protected by `X-Internal-Key` (same shared secret used by
 * the AI service). Used by `services/conversation` after the agent declines
 * or hangs up an incoming voice call: the DB state transition is not enough,
 * the upstream Twilio leg keeps the customer on the line until we explicitly
 * mark the call `completed`.
 *
 * Looks up the session row to find (a) the customer call SID and (b) the
 * owning tenant, resolves the per-tenant VoiceProvider, then calls
 * `provider.endCall({ callSid })`. Idempotent at the provider level - a
 * second terminate for an already-finished call returns 200 with `noop=true`.
 */
import { Router, Request, Response } from "express";
import { prisma } from "@chatcenter/shared";
import type { Logger } from "../lib/logger";
import type { VoiceProviderResolver } from "../providers/voice-provider";
import { NoActiveVoiceChannelError } from "../providers/resolve-provider";

const DEFAULT_INTERNAL_KEY = "chatcenter-internal-2026";

export function createVoiceTerminateRouter(opts: {
  resolveProvider: VoiceProviderResolver;
  logger: Logger;
}): Router {
  const router = Router();
  const { resolveProvider, logger } = opts;

  router.post("/sessions/:sessionId/terminate", async (req: Request, res: Response) => {
    const expected = process.env.INTERNAL_SERVICE_KEY || DEFAULT_INTERNAL_KEY;
    const got = req.headers["x-internal-key"];
    if (!got || got !== expected) {
      res.status(403).json({ error: "forbidden" });
      return;
    }

    const sessionId = String(req.params.sessionId || "");
    if (!sessionId) {
      res.status(400).json({ error: "sessionId_required" });
      return;
    }

    // Pull tenantId + callSid in one query. We deliberately don't gate on
    // session state (e.g. require RINGING) - the caller already enforced
    // that. This route's only job is to drop the upstream leg.
    const session = await (prisma as any).voiceCallSession
      .findUnique({
        where: { id: sessionId },
        select: { id: true, tenantId: true, callSid: true },
      })
      .catch(() => null);

    if (!session) {
      res.status(404).json({ error: "session_not_found" });
      return;
    }
    if (!session.callSid) {
      // No upstream SID stored ⇒ nothing to terminate. Treat as no-op so the
      // caller doesn't have to special-case sessions that never reached Twilio.
      logger.info({ sessionId }, "voice-terminate: noop (no callSid stored)");
      res.json({ data: { terminated: false, reason: "no_call_sid" } });
      return;
    }

    let provider;
    try {
      provider = await resolveProvider(session.tenantId);
    } catch (err) {
      if (err instanceof NoActiveVoiceChannelError) {
        // Channel was disconnected between answer and decline - nothing we
        // can do upstream. Log + return so the caller can move on.
        logger.warn({ sessionId, tenantId: session.tenantId }, "voice-terminate: no active channel");
        res.json({ data: { terminated: false, reason: "no_active_channel" } });
        return;
      }
      logger.error({ err, sessionId }, "voice-terminate: provider resolve failed");
      res.status(500).json({ error: "provider_resolve_failed" });
      return;
    }

    try {
      await provider.endCall({ callSid: session.callSid });
      res.json({ data: { terminated: true, callSid: session.callSid } });
    } catch (err: any) {
      logger.error({ err, sessionId, callSid: session.callSid }, "voice-terminate: endCall failed");
      res.status(502).json({ error: "end_call_failed", detail: err?.message });
    }
  });

  return router;
}
