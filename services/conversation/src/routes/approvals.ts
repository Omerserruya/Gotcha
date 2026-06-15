/**
 * Approval request REST surface.
 *
 * Owns the human-facing side of the F4 bot-surface approval flow:
 *   - GET  /api/approvals               - list for tenant (optional filters)
 *   - GET  /api/approvals/:id           - single, with full rich-card data
 *   - POST /api/approvals/:id/approve   - human clicks Approve
 *   - POST /api/approvals/:id/reject    - human clicks Reject with reason
 *
 * The "actually run the approved action" step does NOT live here - that
 * stays in the bot engine / action-executor. This route only transitions
 * ApprovalRequest.status and records the human's decision. The bot
 * engine's resume-on-approval worker picks up APPROVED rows, dispatches
 * them through executeAction() with approved=true, and advances the
 * paused conversation.
 *
 * Separation of concerns: REST mutates approval state; executor runs
 * the tool; audit log captures both. See memory/bug_f4_approval_wrong_surface.md.
 */
import { Router, Request, Response } from "express";
import {
  prisma,
  authenticate,
  resolveTenant,
  requireActiveTenant,
  approveRequest,
  rejectRequest,
  findPendingByConversation,
  publishEvent,
  outgoingMessageQueue,
} from "@chatcenter/shared";

/**
 * Dispatch an approved action by calling the AI service.
 *
 * Two paths because the bot's tool surface has two shapes:
 *   - `integration_<slug>` (e.g. integration_create_lead) - the bot's
 *     auto-dispatch path resolves slug → TenantTool and POSTs to
 *     /api/ai-assist/:conversationId/tools/execute. Approved-tool
 *     dispatch must use the SAME path so the lead/deal/etc. actually
 *     reaches the connected integration. Without this branch, approval
 *     would silently no-op - the action-planner executor's switch only
 *     knows the legacy hardcoded action names (tag_contact, update_crm,
 *     create_ticket, …) and throws on anything else.
 *   - Everything else falls through to the legacy action-planner
 *     /execute path with `approved=true`.
 *
 * In both cases we parse the inner result so we don't return ok:true
 * just because the HTTP call returned 200. Without that, a downstream
 * tool error would still trigger the post-approval customer message,
 * confusing the user.
 *
 * Best-effort: failure is logged but does NOT roll the ApprovalRequest
 * back to PENDING - the human already decided. A follow-up worker can
 * retry from APPROVED rows.
 */
async function dispatchApprovedAction(args: {
  tenantId: string;
  approvalId: string;
  conversationId: string;
  tool: string;
  params: Record<string, unknown>;
  approvedBy: string;
  authToken?: string;
}): Promise<{ ok: boolean; error?: string; result?: unknown }> {
  const base = (process.env.AI_SERVICE_URL ?? "http://ai:4006").replace(/\/$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = args.authToken ?? process.env.INTERNAL_SERVICE_TOKEN;
  if (token) headers["Authorization"] = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  headers["x-tenant-id"] = args.tenantId;

  // ── Integration tools - same path the bot uses ─────────────
  if (args.tool.startsWith("integration_")) {
    const slug = args.tool.slice("integration_".length);
    let tenantTool: { id: string } | null = null;
    try {
      tenantTool = await prisma.tenantTool.findFirst({
        where: {
          tenantId: args.tenantId,
          isEnabled: true,
          tenantIntegration: { status: "CONNECTED" },
          catalogTool: { slug },
        },
        select: { id: true },
      });
    } catch (err: any) {
      return { ok: false, error: `tenantTool lookup failed: ${err?.message}` };
    }
    if (!tenantTool) {
      return { ok: false, error: `no connected tool for slug "${slug}"` };
    }

    try {
      const res = await fetch(
        `${base}/api/ai-assist/${encodeURIComponent(args.conversationId)}/tools/execute`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ tenantToolId: tenantTool.id, input: args.params }),
        },
      );
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false, error: data?.error || `executor returned ${res.status}` };
      }
      // The /tools/execute endpoint wraps the connector result in
      // `{ data: { ok, output|error, status } }` - propagate inner failure.
      const exec = data?.data;
      if (exec && exec.ok === false) {
        return {
          ok: false,
          error: exec.error || `tool ${args.tool} failed (status ${exec.status ?? "?"})`,
          result: exec,
        };
      }
      return { ok: true, result: exec ?? data };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? "fetch failed" };
    }
  }

  // ── Legacy action-planner path ─────────────────────────────
  try {
    // Merge conversationId into the step params so executors that need it
    // (schedule_followup, create_task, ...) can self-resolve the contact
    // when the original LLM tool args didn't include it.
    const stepParams: Record<string, unknown> = { ...args.params };
    if (!stepParams.conversationId) stepParams.conversationId = args.conversationId;
    const res = await fetch(`${base}/api/action-planner/execute`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        plan: {
          summary: `Approved action: ${args.tool}`,
          requiresApproval: true,
          steps: [
            {
              tool: args.tool,
              params: stepParams,
              reason: `Human-approved via approval request ${args.approvalId}`,
              riskLevel: "high",
            },
          ],
        },
        approved: true,
        approvedBy: args.approvedBy,
        idempotencyKey: `approval:${args.approvalId}`,
      }),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: data?.error || `executor returned ${res.status}` };
    }
    // /api/action-planner/execute returns { results: [{ ok, error, ... }] }
    // - propagate the first non-ok step so a tool failure doesn't fire the
    // post-approval customer message.
    const results = Array.isArray(data?.results) ? data.results : [];
    const firstFail = results.find((r: any) => r && r.ok === false);
    if (firstFail) {
      return { ok: false, error: firstFail.error || firstFail.skipReason || `tool ${args.tool} failed`, result: data };
    }
    return { ok: true, result: data };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "fetch failed" };
  }
}

const router = Router();
router.use(authenticate, resolveTenant, requireActiveTenant());

/**
 * GET /api/approvals
 * List approval requests for this tenant. Supports:
 *   - ?status=PENDING       default
 *   - ?conversationId=xxx   scope to one conversation
 *   - ?contactId=xxx        scope to one contact
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const status = (req.query.status as string | undefined) ?? "PENDING";
    const conversationId = req.query.conversationId as string | undefined;
    const contactId = req.query.contactId as string | undefined;

    const where: any = { tenantId, status };
    if (conversationId) where.conversationId = conversationId;
    if (contactId) where.contactId = contactId;

    const rows = await (prisma as any).approvalRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    // Resolve user ids → display names so the UI doesn't render raw cuids.
    // `requestedBy` may be a user id, "bot", or "flow:<id>" / "ai-agent:<id>";
    // only treat it as a user id when it's a bare cuid (no prefix).
    const userIds = new Set<string>();
    for (const r of rows) {
      if (r.decidedBy) userIds.add(r.decidedBy as string);
      if (r.requestedBy && !String(r.requestedBy).includes(":") && r.requestedBy !== "bot") {
        userIds.add(r.requestedBy as string);
      }
    }
    const userMap = new Map<string, string>();
    if (userIds.size > 0) {
      const users = await prisma.user.findMany({
        where: { tenantId, id: { in: [...userIds] } },
        select: { id: true, name: true, email: true },
      });
      for (const u of users) userMap.set(u.id, u.name || u.email || u.id);
    }
    const enriched = rows.map((r: any) => ({
      ...r,
      decidedByName: r.decidedBy ? userMap.get(r.decidedBy as string) ?? null : null,
      requestedByName:
        r.requestedBy && !String(r.requestedBy).includes(":") && r.requestedBy !== "bot"
          ? userMap.get(r.requestedBy as string) ?? null
          : null,
    }));
    return res.json({ data: enriched });
  } catch (err: any) {
    console.error("approvals.list error:", err);
    return res.status(500).json({ error: "Failed to list approvals" });
  }
});

/**
 * GET /api/approvals/:id
 * Full record + enrichment for the rich in-conversation approval card:
 *   - conversation + recent messages (last 5)
 *   - contact snapshot
 */
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const row = await (prisma as any).approvalRequest.findFirst({
      where: { id: req.params.id, tenantId },
    });
    if (!row) return res.status(404).json({ error: "approval not found" });

    // Load the surrounding context so the frontend card doesn't need
    // N extra round trips.
    const [conversation, contact, recentMessages] = await Promise.all([
      prisma.conversation.findFirst({
        where: { id: row.conversationId, tenantId },
      }),
      row.contactId
        ? prisma.contact.findFirst({ where: { id: row.contactId, tenantId } })
        : Promise.resolve(null),
      prisma.message.findMany({
        where: { conversationId: row.conversationId, tenantId },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          id: true,
          direction: true,
          body: true,
          createdAt: true,
          senderName: true,
        },
      }),
    ]);

    return res.json({
      approval: row,
      conversation,
      contact,
      recentMessages: recentMessages.reverse(),
    });
  } catch (err: any) {
    console.error("approvals.get error:", err);
    return res.status(500).json({ error: "Failed to load approval" });
  }
});

/**
 * POST /api/approvals/:id/approve
 * Body: { decisionReason?, modifiedParams? }
 *
 * Separation of duties: the approver MUST NOT be the same actor who
 * authored the originating bot action. For bot-initiated requests
 * (requestedBy starts with "bot" / "flow:" / "ai-agent:") this is
 * trivially satisfied - the actor is the bot, not a human. For
 * human-initiated requests (rare under the F4 model), we reject
 * same-actor approvals.
 */
router.post("/:id/approve", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const actorId = (req as any).user?.userId ?? (req as any).user?.id;
    if (!actorId) return res.status(401).json({ error: "authentication required" });

    const row = await (prisma as any).approvalRequest.findFirst({
      where: { id: req.params.id, tenantId },
    });
    if (!row) return res.status(404).json({ error: "approval not found" });
    if (row.status !== "PENDING") {
      return res.status(409).json({ error: `approval is already ${row.status.toLowerCase()}` });
    }
    if (row.expiresAt && row.expiresAt < new Date()) {
      return res.status(409).json({ error: "approval has expired" });
    }
    // Same-actor defense-in-depth
    if (row.requestedBy === actorId) {
      return res.status(403).json({
        error: "approver must be a different actor than the requester",
      });
    }

    const effectiveParams =
      req.body?.modifiedParams && typeof req.body.modifiedParams === "object"
        ? (req.body.modifiedParams as Record<string, unknown>)
        : (row.params as Record<string, unknown>);

    const updated = await approveRequest(
      tenantId,
      row.id,
      actorId,
      req.body?.modifiedParams,
      req.body?.decisionReason,
    );

    // Un-pause the conversation so the bot resumes on the next inbound.
    // incoming-worker continues the bot loop only on "ai_agent".
    try {
      await prisma.conversation.update({
        where: { id: row.conversationId },
        data: { handledBy: "ai_agent" },
      });
    } catch (err: any) {
      console.error("approvals.approve: failed to un-pause conversation:", err.message);
    }

    // Fire the approved action via the ai service executor. Best-effort:
    // failure is logged but does NOT roll back the approval record.
    const authToken = (req.headers.authorization as string | undefined) ?? undefined;
    const dispatch = await dispatchApprovedAction({
      tenantId,
      approvalId: row.id,
      conversationId: row.conversationId,
      tool: row.tool,
      params: effectiveParams,
      approvedBy: actorId,
      authToken,
    });
    if (!dispatch.ok) {
      console.error(
        `[approvals] dispatch failed for ${row.id}: ${dispatch.error}`,
      );
    }

    // Customer-facing continuation: once the action succeeds, ask the AI
    // agent to continue the conversation in the customer's language. The
    // bot stays in charge - no "team member will reach out" hand-off.
    // If the oneshot fails, fall back to silence - the next inbound
    // message will trigger a normal bot turn anyway.
    if (dispatch.ok) {
      try {
        const conv = await prisma.conversation.findFirst({
          where: { id: row.conversationId, tenantId },
          select: {
            id: true,
            channel: true,
            channelAccountId: true,
            customerExternalId: true,
            customerName: true,
            assignedAiAgentId: true,
          },
        });
        // Pull a few recent inbound messages so the model can detect the
        // conversation's language even when the most-recent message is
        // language-less (e.g. just an email or "ok").
        const recentInbound = await prisma.message.findMany({
          where: { tenantId, conversationId: row.conversationId, direction: "INBOUND" },
          orderBy: { createdAt: "desc" },
          take: 5,
          select: { body: true },
        });
        const inboundSample = recentInbound
          .map((m) => m.body?.trim())
          .filter((s): s is string => !!s)
          .reverse()
          .join("\n");

        const aiAgentId = (conv as any)?.assignedAiAgentId as string | undefined;
        let body: string | null = null;
        if (conv && aiAgentId) {
          const userInput =
            `[INTERNAL CONTEXT - do not echo to the customer]\n` +
            `A background action you triggered (${row.tool}) just succeeded.\n` +
            `Customer's recent messages (oldest → newest):\n${inboundSample}\n\n` +
            (conv.customerName ? `Customer name: ${conv.customerName}\n` : "") +
            `\nTASK: Send ONE short reply to the customer that keeps the conversation moving forward.\n` +
            `Rules:\n` +
            `- Detect the language from the FIRST customer message above (or any earlier non-trivial message). Reply in THAT language. If any message contains Hebrew characters, the language is Hebrew. Do not default to English.\n` +
            `- Do NOT say "a team member will reach out", "we'll get back to you", or anything that implies handing off - you are still handling this conversation.\n` +
            `- Do NOT mention the CRM, lead creation, or any internal system.\n` +
            `- Be brief, in-character, and propose the next step in the conversation if appropriate.\n`;

          const aiBase = (process.env.AI_SERVICE_URL ?? "http://ai:4006").replace(/\/$/, "");
          const internalKey = process.env.INTERNAL_SERVICE_KEY || "chatcenter-internal-2026";
          try {
            const oneshotRes = await fetch(`${aiBase}/api/ai-bot/oneshot`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-Internal-Key": internalKey },
              body: JSON.stringify({
                tenantId,
                aiAgentId,
                userInput,
                feature: "post_approval_continuation",
              }),
            });
            const data: any = await oneshotRes.json().catch(() => ({}));
            if (oneshotRes.ok && data?.reply && typeof data.reply === "string") {
              body = data.reply.trim();
            }
          } catch (err: any) {
            console.warn(
              "approvals.approve: post-approval oneshot failed; staying silent:",
              err?.message,
            );
          }
        }

        if (body && conv && conv.channelAccountId && conv.customerExternalId) {
          const msg = await prisma.message.create({
            data: {
              tenantId,
              conversationId: conv.id,
              channel: conv.channel,
              direction: "OUTBOUND",
              body,
              senderName: "AI Bot",
              status: "PENDING",
              metadata: { source: "approval_confirmation", approvalId: row.id, tool: row.tool },
            },
          });
          await outgoingMessageQueue.add(
            "send",
            {
              tenantId,
              conversationId: conv.id,
              channel: conv.channel,
              channelAccountId: conv.channelAccountId,
              recipientExternalId: conv.customerExternalId,
              body,
              messageType: "text",
              senderName: "AI Bot",
              messageId: msg.id,
            },
            { attempts: 3, backoff: { type: "exponential", delay: 1000 } },
          );
          await prisma.conversation.update({
            where: { id: conv.id },
            data: { lastMessageAt: new Date() },
          });
        }
      } catch (err: any) {
        console.error(
          "approvals.approve: post-approval customer message failed:",
          err?.message,
        );
      }
    }

    // Notify subscribers (inbox UIs, worker retry, etc.)
    publishEvent({
      event: "approval:approved",
      tenantId,
      data: {
        approvalId: row.id,
        conversationId: row.conversationId,
        tool: row.tool,
        dispatchOk: dispatch.ok,
      },
    }).catch(() => {});

    return res.json({
      approval: updated,
      dispatch: {
        ok: dispatch.ok,
        error: dispatch.error,
      },
    });
  } catch (err: any) {
    console.error("approvals.approve error:", err);
    return res.status(500).json({ error: "Failed to approve" });
  }
});

/**
 * POST /api/approvals/:id/reject
 * Body: { decisionReason }
 * Rejection reason is REQUIRED - no silent "just no". The bot resume
 * worker uses it to craft the fallback customer message.
 */
router.post("/:id/reject", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const actorId = (req as any).user?.userId ?? (req as any).user?.id;
    if (!actorId) return res.status(401).json({ error: "authentication required" });
    const { decisionReason } = req.body ?? {};
    if (!decisionReason || typeof decisionReason !== "string") {
      return res.status(400).json({ error: "decisionReason is required" });
    }

    const row = await (prisma as any).approvalRequest.findFirst({
      where: { id: req.params.id, tenantId },
    });
    if (!row) return res.status(404).json({ error: "approval not found" });
    if (row.status !== "PENDING") {
      return res.status(409).json({ error: `approval is already ${row.status.toLowerCase()}` });
    }

    const updated = await rejectRequest(tenantId, row.id, actorId, decisionReason);

    // Un-pause the conversation but route to human. Rejected actions
    // mean the bot shouldn't retry - hand off to a human so they can
    // respond directly.
    try {
      await prisma.conversation.update({
        where: { id: row.conversationId },
        data: { handledBy: "human", isHandedOver: true },
      });
    } catch (err: any) {
      console.error("approvals.reject: failed to reroute conversation:", err.message);
    }

    // F7 handoff trigger: fire-and-forget analysis on the AI service so
    // the agent about to pick this up sees a ready-made summary instead
    // of scrolling the raw transcript.
    (async () => {
      try {
        const base = process.env.AI_SERVICE_URL ?? "http://ai:4006";
        const internalToken = process.env.INTERNAL_SERVICE_TOKEN;
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "x-tenant-id": tenantId,
        };
        if (internalToken) {
          headers["Authorization"] = internalToken.startsWith("Bearer ")
            ? internalToken
            : `Bearer ${internalToken}`;
        }
        await fetch(`${base.replace(/\/$/, "")}/api/ai-assist/${row.conversationId}/analyze`, {
          method: "POST",
          headers,
          body: JSON.stringify({ tenantId, trigger: "handoff" }),
        });
      } catch (err: any) {
        console.error("approvals.reject: analyzeConversation failed:", err?.message);
      }
    })();

    publishEvent({
      event: "approval:rejected",
      tenantId,
      data: {
        approvalId: row.id,
        conversationId: row.conversationId,
        tool: row.tool,
        reason: decisionReason,
      },
    }).catch(() => {});

    return res.json({ approval: updated });
  } catch (err: any) {
    console.error("approvals.reject error:", err);
    return res.status(500).json({ error: "Failed to reject" });
  }
});

export default router;
