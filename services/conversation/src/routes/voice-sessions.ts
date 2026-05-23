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
import { getHistoryByCustomerExternalId } from "../services/conversation.service";

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

// ─── GET /missed ──────────────────────────────────────────────
// Recent MISSED inbound calls for the agent's tenant. Enriched with the
// matching Contact row (if any) so the UI can render a name + tags
// without an extra round trip. Limited to inbound — outbound MISSED
// rows are a Twilio quirk (caller-decline) and don't belong in this
// inbox view.
router.get("/missed", async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const sessions = await prisma.voiceCallSession.findMany({
      where: {
        tenantId: req.tenantId!,
        state: "MISSED",
        direction: "inbound",
        // Server-side handled flag — set when an outbound to the same
        // customerNumber went ACTIVE, or by an explicit dismiss POST.
        // Keeps the inbox cleared once the loop is closed, even when
        // the callback came from the WhatsApp template button.
        handledAt: null,
      },
      orderBy: { startedAt: "desc" },
      take: limit,
      select: {
        id: true, callSid: true, conversationId: true, channelId: true,
        customerNumber: true, customerId: true, agentId: true, assignedAgentId: true,
        startedAt: true, meta: true,
      },
    });
    // Bulk-resolve contacts (by phone). Conversation has customerName too
    // but the Contact row carries tags/email; prefer it when it exists.
    const phones = Array.from(new Set(sessions.map((s) => s.customerNumber).filter(Boolean)));
    const contacts = phones.length === 0
      ? []
      : await prisma.contact.findMany({
          where: { tenantId: req.tenantId!, phone: { in: phones as string[] } },
          select: { id: true, displayName: true, phone: true, email: true, tags: true },
        });
    const byPhone = new Map(contacts.map((c) => [c.phone || "", c]));
    res.json({
      data: sessions.map((s) => ({
        ...s,
        contact: byPhone.get(s.customerNumber || "") ?? null,
      })),
    });
  } catch (err) {
    console.error("voice-sessions.missed error:", err);
    res.status(500).json({ error: "failed_to_list_missed" });
  }
});

// ─── POST /missed/:id/callback ────────────────────────────────
// Return-call entry point for the missed-calls inbox. Looks up the
// missed session, then proxies to voice-copilot's /callbacks/initiate
// endpoint with the channel's outboundMode policy applied. IN_PLATFORM
// mode is unsupported here (the agent would need to dial from the
// browser-side dialer — return a 409 so the UI can guide them).
router.post("/missed/:id/callback", async (req: Request, res: Response) => {
  try {
    const session = await loadSessionForTenant(String(req.params.id), req.tenantId!);
    if (!session) { res.status(404).json({ error: "not_found" }); return; }
    if (session.state !== "MISSED") {
      res.status(409).json({ error: "not_missed", currentState: session.state });
      return;
    }
    if (!session.channelId) {
      res.status(409).json({ error: "session_missing_channel" });
      return;
    }
    const channel = await prisma.communicationChannel.findUnique({
      where: { id: session.channelId },
      include: { voiceChannel: true },
    });
    if (!channel?.voiceChannel || channel.tenantId !== req.tenantId!) {
      res.status(404).json({ error: "channel_not_found" });
      return;
    }
    if (channel.voiceChannel.outboundMode !== "AGENT_FIRST") {
      // The browser dialer flow handles IN_PLATFORM outbound directly.
      // Surface a hint instead of silently failing.
      res.status(409).json({
        error: "outbound_mode_in_platform",
        hint: "use_browser_dialer",
      });
      return;
    }
    if (!session.customerNumber) {
      res.status(409).json({ error: "missing_customer_number" });
      return;
    }
    const url = process.env.VOICE_COPILOT_URL || "http://voice-copilot:4007";
    const key = process.env.INTERNAL_SERVICE_KEY || "chatcenter-internal-2026";
    const upstream = await fetch(`${url}/api/voice-copilot/callbacks/initiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Key": key },
      body: JSON.stringify({
        channelId: session.channelId,
        customerNumber: session.customerNumber,
        // Default-route to the agent who initiates the callback; falls
        // back to channel.defaultAgent if they don't have a phone.
        agentId: req.user!.userId,
        conversationId: session.conversationId,
        label: `callback-${session.id}`,
      }),
    });
    const text = await upstream.text().catch(() => "");
    if (!upstream.ok) {
      res.status(upstream.status === 403 ? 502 : upstream.status).json({
        error: "upstream_failed", status: upstream.status, detail: text.slice(0, 200),
      });
      return;
    }
    res.json(JSON.parse(text || "{}"));
  } catch (err) {
    console.error("voice-sessions.missed.callback error:", err);
    res.status(500).json({ error: "failed_to_callback" });
  }
});

// ─── POST /missed/:id/handle ───────────────────────────────────
// Explicit "Mark as handled" from the inbox UI. Stamps `handledAt` on
// every MISSED inbound session for the same (tenant, customerNumber)
// — same cascade semantics as the auto-handle on ACTIVE. Idempotent.
router.post("/missed/:id/handle", async (req: Request, res: Response) => {
  try {
    const session = await loadSessionForTenant(String(req.params.id), req.tenantId!);
    if (!session) { res.status(404).json({ error: "not_found" }); return; }
    if (session.state !== "MISSED" || session.direction !== "inbound") {
      res.status(409).json({ error: "not_missed", currentState: session.state });
      return;
    }
    const now = new Date();
    const updated = await prisma.voiceCallSession.updateMany({
      where: {
        tenantId: req.tenantId!,
        direction: "inbound",
        state: "MISSED",
        handledAt: null,
        ...(session.customerNumber
          ? { customerNumber: session.customerNumber }
          : { id: session.id }),
      },
      data: { handledAt: now },
    });
    res.json({ data: { handledCount: updated.count, customerNumber: session.customerNumber } });
  } catch (err) {
    console.error("voice-sessions.missed.handle error:", err);
    res.status(500).json({ error: "failed_to_handle" });
  }
});

// ─── GET /missed/:id/detail ────────────────────────────────────
// Rich enrichment for the missed-call detail drawer: contact + CRM
// custom fields, the latest CustomerBrief (persistent behavioral
// summary), and the 3 most-recent prior conversations with their
// aiSummary. Read-only; missed-call list is cheap, but this endpoint
// pulls heavier data only when the agent actually opens the drawer.
router.get("/missed/:id/detail", async (req: Request, res: Response) => {
  try {
    const session = await loadSessionForTenant(String(req.params.id), req.tenantId!);
    if (!session) { res.status(404).json({ error: "not_found" }); return; }
    if (session.state !== "MISSED" || session.direction !== "inbound") {
      res.status(409).json({ error: "not_missed", currentState: session.state });
      return;
    }

    // Contact lookup — prefer the linked customerId, fall back to phone match.
    // Skip merged-into shells so we always return the surviving row.
    const contact = session.customerId
      ? await prisma.contact.findFirst({
          where: { id: session.customerId, tenantId: req.tenantId!, mergedIntoId: null },
          select: {
            id: true, displayName: true, email: true, phone: true, tags: true,
            metadata: true, personId: true, lastInteractionAt: true,
          },
        })
      : session.customerNumber
        ? await prisma.contact.findFirst({
            where: { tenantId: req.tenantId!, phone: session.customerNumber, mergedIntoId: null },
            select: {
              id: true, displayName: true, email: true, phone: true, tags: true,
              metadata: true, personId: true, lastInteractionAt: true,
            },
          })
        : null;

    // CustomerBrief lookup uses dedicated columns rather than the identityKey
    // string — the writer keys briefs as `person:` > `crm:` > `contact:`,
    // so a string-match on `contact:<id>` misses any CRM-linked customer.
    // The OR-on-columns mirrors how the AI service itself reads the row.
    const briefFilters: Array<Record<string, string>> = [];
    if (contact?.personId) briefFilters.push({ personId: contact.personId });
    if (contact?.id) briefFilters.push({ contactId: contact.id });
    const brief = briefFilters.length === 0
      ? null
      : await prisma.customerBrief.findFirst({
          where: { tenantId: req.tenantId!, OR: briefFilters },
          orderBy: { generatedAt: "desc" },
          select: {
            brief: true, signals: true, tone: true, mood: true,
            recommendedBehaviors: true, conversationCount: true,
            generatedAt: true, locale: true,
          },
        });

    // Recent conversations across ALL channels — delegate to the canonical
    // cross-channel sibling walk used by the chat right-panel "Context"
    // tab. It handles the cases a naive (channel, externalId) match misses:
    //   • Instagram PSIDs / Messenger PSIDs (no phone in externalId)
    //   • WhatsApp's digits-without-`+` externalId vs Voice's E.164 form
    //   • CRM-pinned identity (metadata.crmContactId, gotcha_psid_* fields)
    //   • Email contacts
    // We feed BOTH phone-format variants because the seed lookup matches
    // on exact externalId and tenants vary between E.164 and bare-digits.
    const seedExternalIds = new Set<string>();
    if (session.customerNumber) {
      seedExternalIds.add(session.customerNumber);
      const digits = session.customerNumber.replace(/\D/g, "");
      if (digits) seedExternalIds.add(digits);
    }
    const allConversations = new Map<string, {
      id: string; channel: string; status: string; aiSummary: string | null;
      lastMessageAt: Date | null; customerName: string | null;
    }>();
    for (const seed of seedExternalIds) {
      const rows = await getHistoryByCustomerExternalId(req.tenantId!, seed, session.conversationId)
        .catch(() => [] as Awaited<ReturnType<typeof getHistoryByCustomerExternalId>>);
      for (const c of rows) {
        if (c.id === session.conversationId) continue;
        if (allConversations.has(c.id)) continue;
        allConversations.set(c.id, {
          id: c.id,
          channel: c.channel,
          status: c.status,
          aiSummary: c.aiSummary,
          lastMessageAt: c.lastMessageAt,
          customerName: c.customerName,
        });
      }
    }
    const priorConversations = Array.from(allConversations.values())
      .sort((a, b) => {
        const ta = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
        const tb = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
        return tb - ta;
      })
      .slice(0, 3);

    res.json({
      data: {
        session: {
          id: session.id,
          conversationId: session.conversationId,
          customerNumber: session.customerNumber,
          startedAt: session.startedAt,
        },
        contact,
        brief,
        priorConversations,
      },
    });
  } catch (err) {
    console.error("voice-sessions.missed.detail error:", err);
    res.status(500).json({ error: "failed_to_load_detail" });
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
    // Decline transitions the DB row, but the customer leg is still ringing
    // on Twilio's side until we tell the provider to hang up. Fire-and-forget
    // — if the upstream hangup fails we've still successfully declined for
    // the agent. The voice-copilot endpoint is idempotent.
    void terminateUpstreamCall(session.id, "declined");
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
    // Drop the upstream provider leg too — DB state alone doesn't end the
    // call for the customer. Especially important when the agent hangs up
    // before the conference fully bridged (current === "RINGING"), since
    // no `endConferenceOnExit` event fires to clean up Twilio's end.
    void terminateUpstreamCall(session.id, "hangup");
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

// ─── POST /:id/add-participant ────────────────────────────────
// Brings a third-party number into the live conference (3-way). Body:
// { to: "+972..." }. Only the assigned agent (or an ADMIN) can add; the
// session must be ACTIVE/HOLD. Proxies to voice-copilot which holds the
// Twilio credentials.
router.post("/:id/add-participant", async (req: Request, res: Response) => {
  try {
    const session = await loadSessionForTenant(String(req.params.id), req.tenantId!);
    if (!session) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const agentId = req.user!.userId;
    if (session.assignedAgentId && session.assignedAgentId !== agentId && req.user!.role !== "ADMIN") {
      res.status(403).json({ error: "not_owner" });
      return;
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const to = typeof body.to === "string" ? body.to.trim() : "";
    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (!to) {
      res.status(400).json({ error: "to_required" });
      return;
    }

    const url = process.env.VOICE_COPILOT_URL || "http://voice-copilot:4007";
    const key = process.env.INTERNAL_SERVICE_KEY || "chatcenter-internal-2026";
    try {
      const upstream = await fetch(
        `${url}/api/voice-copilot/sessions/${encodeURIComponent(session.id)}/add-participant`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Internal-Key": key },
          body: JSON.stringify({ to, label: label || undefined }),
        },
      );
      const text = await upstream.text().catch(() => "");
      if (!upstream.ok) {
        res.status(upstream.status === 403 ? 502 : upstream.status).json({
          error: "upstream_failed",
          status: upstream.status,
          detail: text.slice(0, 200),
        });
        return;
      }
      res.json(JSON.parse(text || "{}"));
    } catch (err: any) {
      console.warn(`[voice-sessions] add-participant upstream threw session=${session.id} err=${err?.message}`);
      res.status(502).json({ error: "upstream_unreachable" });
    }
  } catch (err) {
    console.error("voice-sessions.add-participant error:", err);
    res.status(500).json({ error: "failed_to_add_participant" });
  }
});

// ─── POST /:id/customer-hold ──────────────────────────────────
// Whisper/consult mode: toggle hold music on the customer's leg so the
// agent can talk privately with an added 3rd party. Body: { hold: bool }.
router.post("/:id/customer-hold", async (req: Request, res: Response) => {
  try {
    const session = await loadSessionForTenant(String(req.params.id), req.tenantId!);
    if (!session) { res.status(404).json({ error: "not_found" }); return; }
    const agentId = req.user!.userId;
    if (session.assignedAgentId && session.assignedAgentId !== agentId && req.user!.role !== "ADMIN") {
      res.status(403).json({ error: "not_owner" }); return;
    }
    const hold = Boolean((req.body as { hold?: unknown })?.hold);

    const url = process.env.VOICE_COPILOT_URL || "http://voice-copilot:4007";
    const key = process.env.INTERNAL_SERVICE_KEY || "chatcenter-internal-2026";
    const upstream = await fetch(
      `${url}/api/voice-copilot/sessions/${encodeURIComponent(session.id)}/customer-hold`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Key": key },
        body: JSON.stringify({ hold }),
      },
    );
    const text = await upstream.text().catch(() => "");
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: "upstream_failed", detail: text.slice(0, 200) });
      return;
    }
    res.json(JSON.parse(text || "{}"));
  } catch (err) {
    console.error("voice-sessions.customer-hold error:", err);
    res.status(500).json({ error: "failed_to_hold" });
  }
});

// ─── POST /:id/agent-leave ────────────────────────────────────
// Cold transfer: drop the agent leg so the customer + the added 3rd
// party continue the call without the agent.
router.post("/:id/agent-leave", async (req: Request, res: Response) => {
  try {
    const session = await loadSessionForTenant(String(req.params.id), req.tenantId!);
    if (!session) { res.status(404).json({ error: "not_found" }); return; }
    const agentId = req.user!.userId;
    if (session.assignedAgentId && session.assignedAgentId !== agentId && req.user!.role !== "ADMIN") {
      res.status(403).json({ error: "not_owner" }); return;
    }

    const url = process.env.VOICE_COPILOT_URL || "http://voice-copilot:4007";
    const key = process.env.INTERNAL_SERVICE_KEY || "chatcenter-internal-2026";
    const upstream = await fetch(
      `${url}/api/voice-copilot/sessions/${encodeURIComponent(session.id)}/agent-leave`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Key": key },
      },
    );
    const text = await upstream.text().catch(() => "");
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: "upstream_failed", detail: text.slice(0, 200) });
      return;
    }
    res.json(JSON.parse(text || "{}"));
  } catch (err) {
    console.error("voice-sessions.agent-leave error:", err);
    res.status(500).json({ error: "failed_to_leave" });
  }
});

// ─── POST /start-outbound ─────────────────────────────────────
// Outbound-dial gate. The frontend always calls this BEFORE opening
// the browser dialer; the response decides which path to take based
// on the channel's `outboundMode`:
//
//   IN_PLATFORM  → frontend dials customer via the Twilio browser SDK
//                  (current behavior unchanged).
//   AGENT_FIRST  → server REST-dials the calling agent's mobile via
//                  voice-copilot `/callbacks/initiate`; once they
//                  answer, the customer is bridged in. Frontend skips
//                  device.connect() and just navigates to /voice/<id>.
//
// Returns 409 with hint codes when AGENT_FIRST is configured but
// can't run (agent missing phone, etc.) so the UI can show a real
// error instead of silently falling back.
router.post("/start-outbound", async (req: Request, res: Response) => {
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const to = typeof body.to === "string" ? body.to.trim() : "";
    const conversationId = typeof body.conversationId === "string" ? body.conversationId.trim() : "";
    const notes = typeof body.notes === "string" ? body.notes : "";
    if (!to) { res.status(400).json({ error: "to_required" }); return; }

    // Resolve the active voice channel for the tenant. If none, no
    // outbound is possible regardless of mode.
    const channel = await prisma.communicationChannel.findFirst({
      where: { tenantId: req.tenantId!, channelType: "VOICE", status: "ACTIVE" },
      include: { voiceChannel: true },
    });
    if (!channel?.voiceChannel) {
      res.status(409).json({ error: "no_active_voice_channel" });
      return;
    }

    const mode = channel.voiceChannel.outboundMode;
    if (mode === "IN_PLATFORM") {
      // Tell the frontend it can proceed with the browser SDK. No
      // session row is pre-created — /twiml/outbound creates it when
      // Twilio hits us back with the agent leg.
      res.json({ data: { mode: "IN_PLATFORM" } });
      return;
    }

    // AGENT_FIRST: forward to voice-copilot. We DON'T pass an agentId
    // override — /callbacks/initiate falls back to the channel's
    // `defaultAgent`, which is the configured target for outbound on
    // this channel. (Missed-call callbacks pass agentId explicitly when
    // a non-default agent is the one returning the call.)
    //
    // Important: only forward the conversationId if it actually exists
    // in this tenant. The IN_PLATFORM flow relies on the frontend
    // generating a fresh UUID and having /twiml/outbound create the
    // Conversation row when Twilio hits back. For AGENT_FIRST the
    // create happens INSIDE /callbacks/initiate — so a non-existing id
    // becomes a FK violation. When the provided id is unknown we drop
    // it and let voice-copilot mint a new one.
    let forwardedConversationId: string | undefined = undefined;
    if (conversationId) {
      const existing = await prisma.conversation.findFirst({
        where: { id: conversationId, tenantId: req.tenantId! },
        select: { id: true },
      });
      if (existing) forwardedConversationId = existing.id;
    }

    const url = process.env.VOICE_COPILOT_URL || "http://voice-copilot:4007";
    const key = process.env.INTERNAL_SERVICE_KEY || "chatcenter-internal-2026";
    try {
      const upstream = await fetch(`${url}/api/voice-copilot/callbacks/initiate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Key": key },
        body: JSON.stringify({
          channelId: channel.id,
          customerNumber: to,
          // No agentId override: ring the channel's defaultAgent (the
          // routing-page selection). To ring "me" instead, the UI would
          // need a separate explicit toggle — not the default behavior.
          conversationId: forwardedConversationId,
          label: notes ? `outbound:${notes.slice(0, 40)}` : "outbound",
        }),
      });
      const text = await upstream.text().catch(() => "");
      if (!upstream.ok) {
        // Surface the upstream's `error` code as the top-level error so
        // the UI's standard error-toast can show it. The known codes:
        //   agent_phone_not_configured   — caller has no phone on profile
        //   caller_id_not_configured     — channel has no caller ID
        //   no_active_channel            — provider can't be resolved
        //   outbound_mode_not_agent_first — race: channel toggled mid-flight
        let detail: Record<string, unknown> = {};
        try { detail = JSON.parse(text || "{}") as Record<string, unknown>; } catch { /* */ }
        const upstreamError = typeof detail.error === "string" ? detail.error : null;
        res.status(upstream.status === 403 ? 502 : upstream.status).json({
          error: upstreamError ?? "agent_first_failed",
          upstreamStatus: upstream.status,
        });
        return;
      }
      const parsed = JSON.parse(text || "{}") as { data?: { sessionId?: string; conversationId?: string; conferenceName?: string } };
      res.json({
        data: {
          mode: "AGENT_FIRST",
          sessionId: parsed.data?.sessionId ?? null,
          conversationId: parsed.data?.conversationId ?? null,
          // Per-channel toggle: when false, the frontend should NOT
          // navigate to the workspace page. "Fire and forget" outbound
          // for agents who aren't sitting at the computer.
          openWorkspace: channel.voiceChannel.openWorkspaceOnAgentFirst,
        },
      });
    } catch (err: any) {
      console.warn(`[voice-sessions] start-outbound upstream threw err=${err?.message}`);
      res.status(502).json({ error: "upstream_unreachable" });
    }
  } catch (err) {
    console.error("voice-sessions.start-outbound error:", err);
    res.status(500).json({ error: "failed_to_start_outbound" });
  }
});

// ─── GET /:id/participants ────────────────────────────────────
// Live + already-left legs for the conference, with optional CRM
// enrichment (when the leg matched a Contact by phone at join time).
// Used by the voice workspace to render per-row controls (hold/kick).
router.get("/:id/participants", async (req: Request, res: Response) => {
  try {
    const session = await loadSessionForTenant(String(req.params.id), req.tenantId!);
    if (!session) { res.status(404).json({ error: "not_found" }); return; }
    const rows = await prisma.voiceSessionParticipant.findMany({
      where: { sessionId: session.id },
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
  } catch (err) {
    console.error("voice-sessions.participants error:", err);
    res.status(500).json({ error: "failed_to_load_participants" });
  }
});

// ─── POST /:id/participants/:participantId/hold ───────────────
router.post("/:id/participants/:participantId/hold", async (req: Request, res: Response) => {
  try {
    const session = await loadSessionForTenant(String(req.params.id), req.tenantId!);
    if (!session) { res.status(404).json({ error: "not_found" }); return; }
    const agentId = req.user!.userId;
    if (session.assignedAgentId && session.assignedAgentId !== agentId && req.user!.role !== "ADMIN") {
      res.status(403).json({ error: "not_owner" }); return;
    }
    const participantId = String(req.params.participantId || "");
    const hold = Boolean((req.body as { hold?: unknown })?.hold);
    if (!participantId) { res.status(400).json({ error: "participantId_required" }); return; }

    // Tenant scope check — never let an agent toggle hold on a participant
    // that belongs to a different tenant's session.
    const participant = await prisma.voiceSessionParticipant.findUnique({
      where: { id: participantId },
      select: { id: true, sessionId: true },
    });
    if (!participant || participant.sessionId !== session.id) {
      res.status(404).json({ error: "participant_not_found" }); return;
    }

    const url = process.env.VOICE_COPILOT_URL || "http://voice-copilot:4007";
    const key = process.env.INTERNAL_SERVICE_KEY || "chatcenter-internal-2026";
    const upstream = await fetch(
      `${url}/api/voice-copilot/sessions/${encodeURIComponent(session.id)}/participants/${encodeURIComponent(participantId)}/hold`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Key": key },
        body: JSON.stringify({ hold }),
      },
    );
    const text = await upstream.text().catch(() => "");
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: "upstream_failed", detail: text.slice(0, 200) });
      return;
    }
    res.json(JSON.parse(text || "{}"));
  } catch (err) {
    console.error("voice-sessions.participant-hold error:", err);
    res.status(500).json({ error: "failed_to_hold_participant" });
  }
});

// ─── POST /:id/participants/:participantId/kick ───────────────
router.post("/:id/participants/:participantId/kick", async (req: Request, res: Response) => {
  try {
    const session = await loadSessionForTenant(String(req.params.id), req.tenantId!);
    if (!session) { res.status(404).json({ error: "not_found" }); return; }
    const agentId = req.user!.userId;
    if (session.assignedAgentId && session.assignedAgentId !== agentId && req.user!.role !== "ADMIN") {
      res.status(403).json({ error: "not_owner" }); return;
    }
    const participantId = String(req.params.participantId || "");
    if (!participantId) { res.status(400).json({ error: "participantId_required" }); return; }

    const participant = await prisma.voiceSessionParticipant.findUnique({
      where: { id: participantId },
      select: { id: true, sessionId: true },
    });
    if (!participant || participant.sessionId !== session.id) {
      res.status(404).json({ error: "participant_not_found" }); return;
    }

    const url = process.env.VOICE_COPILOT_URL || "http://voice-copilot:4007";
    const key = process.env.INTERNAL_SERVICE_KEY || "chatcenter-internal-2026";
    const upstream = await fetch(
      `${url}/api/voice-copilot/sessions/${encodeURIComponent(session.id)}/participants/${encodeURIComponent(participantId)}/kick`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Key": key },
      },
    );
    const text = await upstream.text().catch(() => "");
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: "upstream_failed", detail: text.slice(0, 200) });
      return;
    }
    res.json(JSON.parse(text || "{}"));
  } catch (err) {
    console.error("voice-sessions.participant-kick error:", err);
    res.status(500).json({ error: "failed_to_kick_participant" });
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

// ─── Internal helpers ─────────────────────────────────────────

/**
 * Tell the voice-copilot service to terminate the upstream provider leg for
 * this session. Fire-and-forget — failures are logged but never block the
 * agent-facing response. The voice-copilot endpoint is idempotent.
 *
 * Why this lives here instead of on the provider directly: this service has
 * no access to the per-tenant decrypted voice credentials. voice-copilot
 * owns that surface (it already resolves the provider per-tenant for the
 * inbound TwiML path), so we round-trip through its internal endpoint.
 */
async function terminateUpstreamCall(sessionId: string, reason: string): Promise<void> {
  const url = process.env.VOICE_COPILOT_URL || "http://voice-copilot:4007";
  const key = process.env.INTERNAL_SERVICE_KEY || "chatcenter-internal-2026";
  try {
    const res = await fetch(`${url}/api/voice-copilot/sessions/${encodeURIComponent(sessionId)}/terminate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Key": key },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[voice-sessions] upstream terminate failed session=${sessionId} reason=${reason} status=${res.status} body=${body.slice(0, 200)}`);
    }
  } catch (err: any) {
    console.warn(`[voice-sessions] upstream terminate threw session=${sessionId} reason=${reason} err=${err?.message}`);
  }
}

export default router;
