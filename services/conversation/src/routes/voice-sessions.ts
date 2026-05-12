/**
 * Voice sessions API (Phase 1 — Live Call CoPilot).
 *
 * Endpoints (all gated by `tenant.voiceCopilotEnabled`):
 *   GET    /api/voice-sessions/active           — RINGING + live for tenant
 *   GET    /api/voice-sessions/:id              — single session
 *   GET    /api/voice-sessions/:id/transcript   — paged voice messages
 *   GET    /api/voice-sessions/:id/context      — CRM enrichment block
 *   POST   /api/voice-sessions/:id/answer       — atomic claim
 *   POST   /api/voice-sessions/:id/decline      — RINGING → MISSED
 *   POST   /api/voice-sessions/:id/hangup       — live → ENDED
 *
 * All routes require an authenticated agent in the same tenant as the
 * session. Tenants where `voiceCopilotEnabled = false` (every existing
 * production tenant by default) get a 404 — looks like the feature
 * doesn't exist, which is intentional during the rollout window.
 */
import { Router, Request, Response, NextFunction } from "express";
import {
  prisma,
  authenticate,
  resolveTenant,
  requireActiveTenant,
  claimIncomingCall,
  transitionVoiceCallSessionState,
  fromLegacyStatus,
  LIVE_STATES,
  markOnline,
  heartbeat,
  type CallState,
} from "@chatcenter/shared";

const router = Router();
router.use(authenticate, resolveTenant, requireActiveTenant());

// Feature-flag gate — short-circuits to 404 for non-enabled tenants.
async function voiceCopilotGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.tenantId! },
      select: { voiceCopilotEnabled: true },
    });
    if (!tenant?.voiceCopilotEnabled) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    next();
  } catch (err) {
    console.error("voice-sessions.gate error:", err);
    res.status(500).json({ error: "gate_check_failed" });
  }
}
router.use(voiceCopilotGate);

// Ensure the session exists and belongs to the agent's tenant.
async function loadSessionForTenant(sessionId: string, tenantId: string) {
  const session = await prisma.voiceCallSession.findUnique({ where: { id: sessionId } });
  if (!session || session.tenantId !== tenantId) return null;
  return session;
}

// ─── GET /active ───────────────────────────────────────────────
router.get("/active", async (req: Request, res: Response) => {
  try {
    const states: CallState[] = ["RINGING", ...Array.from(LIVE_STATES) as CallState[]];
    const sessions = await prisma.voiceCallSession.findMany({
      where: { tenantId: req.tenantId!, state: { in: states } },
      orderBy: { startedAt: "desc" },
      select: {
        id: true,
        callSid: true,
        conversationId: true,
        direction: true,
        state: true,
        status: true,
        customerNumber: true,
        agentId: true,
        assignedAgentId: true,
        claimedAt: true,
        startedAt: true,
        answeredAt: true,
        channelId: true,
        meta: true,
      },
    });
    res.json({ data: sessions });
  } catch (err) {
    console.error("voice-sessions.active error:", err);
    res.status(500).json({ error: "failed_to_list" });
  }
});

// ─── GET /:id ──────────────────────────────────────────────────
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const session = await loadSessionForTenant(String(req.params.id), req.tenantId!);
    if (!session) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ data: session });
  } catch (err) {
    console.error("voice-sessions.get error:", err);
    res.status(500).json({ error: "failed_to_load" });
  }
});

// ─── GET /:id/transcript ───────────────────────────────────────
router.get("/:id/transcript", async (req: Request, res: Response) => {
  try {
    const session = await loadSessionForTenant(String(req.params.id), req.tenantId!);
    if (!session) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const messages = await prisma.message.findMany({
      where: { conversationId: session.conversationId, channel: "VOICE" },
      orderBy: { createdAt: "asc" },
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        id: true,
        direction: true,
        body: true,
        messageType: true,
        senderName: true,
        createdAt: true,
        metadata: true,
      },
    });
    const hasMore = messages.length > limit;
    const items = hasMore ? messages.slice(0, limit) : messages;
    res.json({
      data: items,
      nextCursor: hasMore ? items[items.length - 1]!.id : null,
    });
  } catch (err) {
    console.error("voice-sessions.transcript error:", err);
    res.status(500).json({ error: "failed_to_load_transcript" });
  }
});

// ─── GET /:id/context ──────────────────────────────────────────
// CRM enrichment for the right-panel cards. Returns prior conversations,
// any persisted summaries, and the contact record (if matched on phone).
// Heavy CRM lookups (lead_search/contact_search) are NOT triggered here —
// the AI service handles those at call-start via its existing prefetch.
router.get("/:id/context", async (req: Request, res: Response) => {
  try {
    const session = await loadSessionForTenant(String(req.params.id), req.tenantId!);
    if (!session) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const [contact, priorConversations, callAnalysis] = await Promise.all([
      session.customerId
        ? prisma.contact.findUnique({
            where: { id: session.customerId },
            select: { id: true, displayName: true, externalId: true, phone: true, email: true, tags: true, metadata: true },
          })
        : Promise.resolve(null),
      // Prior conversations: prefer matching by the customer's external id /
      // phone since Conversation doesn't carry a customerId FK. Fall back to
      // customerName for legacy un-linked rows.
      prisma.conversation.findMany({
        where: {
          tenantId: req.tenantId!,
          id: { not: session.conversationId },
          OR: [
            { customerExternalId: session.customerNumber },
            { customerName: session.customerNumber },
          ],
        },
        take: 10,
        orderBy: { updatedAt: "desc" },
        select: { id: true, channel: true, status: true, customerName: true, lastMessageAt: true, aiSummary: true },
      }),
      prisma.callAnalysis.findUnique({
        where: { conversationId: session.conversationId },
        select: { rollingSummary: true, finalSummary: true, status: true },
      }),
    ]);
    res.json({
      data: {
        contact,
        priorConversations,
        callAnalysis,
      },
    });
  } catch (err) {
    console.error("voice-sessions.context error:", err);
    res.status(500).json({ error: "failed_to_load_context" });
  }
});

// ─── POST /:id/answer ──────────────────────────────────────────
router.post("/:id/answer", async (req: Request, res: Response) => {
  try {
    const session = await loadSessionForTenant(String(req.params.id), req.tenantId!);
    if (!session) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const agentId = req.user!.userId;
    const result = await claimIncomingCall(session.id, agentId);
    if (!result.ok) {
      const code = result.reason === "not_ringing" ? 410
        : result.reason === "agent_busy" ? 409
        : result.reason === "already_claimed" ? 409
        : 500;
      res.status(code).json({ error: result.reason, ...(result.reason === "agent_busy" ? { busyOnSessionId: result.busyOnSessionId } : {}) });
      return;
    }
    res.json({ data: result.session });
  } catch (err) {
    console.error("voice-sessions.answer error:", err);
    res.status(500).json({ error: "failed_to_claim" });
  }
});

// ─── POST /:id/decline ─────────────────────────────────────────
router.post("/:id/decline", async (req: Request, res: Response) => {
  try {
    const session = await loadSessionForTenant(String(req.params.id), req.tenantId!);
    if (!session) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const current: CallState = (session.state as CallState | null) ?? fromLegacyStatus(session.status);
    if (current !== "RINGING") {
      res.status(410).json({ error: "not_ringing", currentState: current });
      return;
    }
    const result = await transitionVoiceCallSessionState(session.id, "MISSED", {
      fromState: "RINGING",
      reason: `declined_by_${req.user!.userId}`,
    });
    if (!result.ok) {
      res.status(409).json({ error: result.reason });
      return;
    }
    res.json({ data: result.session });
  } catch (err) {
    console.error("voice-sessions.decline error:", err);
    res.status(500).json({ error: "failed_to_decline" });
  }
});

// ─── POST /:id/hangup ──────────────────────────────────────────
router.post("/:id/hangup", async (req: Request, res: Response) => {
  try {
    const session = await loadSessionForTenant(String(req.params.id), req.tenantId!);
    if (!session) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const agentId = req.user!.userId;
    // Only the assigned agent (or an admin) can hang up — prevents
    // accidental ends from a stale tab in another window.
    if (session.assignedAgentId && session.assignedAgentId !== agentId && req.user!.role !== "ADMIN") {
      res.status(403).json({ error: "not_owner" });
      return;
    }
    const current: CallState = (session.state as CallState | null) ?? fromLegacyStatus(session.status);
    if (!LIVE_STATES.has(current) && current !== "RINGING") {
      res.status(410).json({ error: "not_live", currentState: current });
      return;
    }
    const result = await transitionVoiceCallSessionState(session.id, "ENDED", {
      fromState: current,
      reason: `hangup_by_${agentId}`,
    });
    if (!result.ok) {
      res.status(409).json({ error: result.reason });
      return;
    }
    // Best-effort presence flip back to ONLINE for the assigned agent.
    const presenceAgentId = session.assignedAgentId ?? agentId;
    try {
      await markOnline(presenceAgentId, session.tenantId);
    } catch {
      /* presence write is best-effort */
    }
    res.json({ data: result.session });
  } catch (err) {
    console.error("voice-sessions.hangup error:", err);
    res.status(500).json({ error: "failed_to_hangup" });
  }
});

// ─── POST /presence/heartbeat ─────────────────────────────────
// Agent client pings every 30s to bump lastSeenAt. Tenants where
// voiceCopilotEnabled = false already 404 via the gate above.
router.post("/presence/heartbeat", async (req: Request, res: Response) => {
  try {
    await heartbeat(req.user!.userId, req.tenantId!);
    res.json({ data: { ok: true } });
  } catch (err) {
    console.error("voice-sessions.presence.heartbeat error:", err);
    res.status(500).json({ error: "failed_heartbeat" });
  }
});

export default router;
