import { getInternalServiceKey } from "@chatcenter/shared";
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
  requireInternalKey,
  approveRequest,
  rejectRequest,
  claimForExecution,
  recordExecutionOutcome,
  revalidateBeforeExecution,
  claimCustomerNotification,
  linkCustomerMessage,
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
  // Fall back through BOTH internal secrets: shared auth accepts either, but
  // this container may only have INTERNAL_SERVICE_KEY set - relying on
  // INTERNAL_SERVICE_TOKEN alone made WhatsApp/sweeper dispatches (no user
  // Authorization header) fail with "Missing or invalid authorization header".
  const token =
    args.authToken ?? process.env.INTERNAL_SERVICE_TOKEN ?? process.env.INTERNAL_SERVICE_KEY;
  if (token) headers["Authorization"] = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  headers["x-tenant-id"] = args.tenantId;

  // ── Kernel-originated approvals (P1-3/B6) - resume through the Capability
  // Runtime, NOT the legacy executor: the stored ExecutionRequest re-enters
  // the Runtime so invariants/verification apply to the HITL write.
  try {
    const row = await (prisma as any).approvalRequest.findFirst({
      where: { id: args.approvalId, tenantId: args.tenantId },
      select: { resumeEnvelope: true },
    });
    if ((row?.resumeEnvelope as any)?.kind === "kernel_operation") {
      const res = await fetch(`${base}/api/agent-loop/execute-approved`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Key": getInternalServiceKey(),
        },
        body: JSON.stringify({ tenantId: args.tenantId, approvalId: args.approvalId }),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: data?.error || `kernel resume returned ${res.status}` };
      const status = data?.data?.status;
      if (status !== "EXECUTED") {
        return { ok: false, error: `kernel resume ended ${status ?? "unknown"}`, result: data?.data };
      }
      return { ok: true, result: data?.data };
    }
  } catch (err: any) {
    return { ok: false, error: `kernel resume dispatch failed: ${err?.message}` };
  }

  // ── Adapter-framework tools (dotted "<provider>.<tool>") ──────────
  // e.g. shopify.cancel_order, stripe.refund_payment. The live bot runs
  // these through executeAdapterTool (integration-framework: credential
  // load + token refresh + rate limit + adapter audit). The ONLY executor
  // that knows them is the AI service's adapter bridge - the legacy
  // action-planner switch below throws "unsupported tool" on them, which
  // is exactly how the approved Matan Amran shopify.cancel_order was
  // recorded SUCCEEDED without Shopify ever being called. Excluded dotted
  // namespaces that are NOT framework adapters: `integration.` (kernel-plane
  // catalog naming - kernel approvals resume via the resumeEnvelope branch
  // above) and `custom.` / `custom_db.` (tenant-defined HTTP/DB tools with
  // their own dispatchers).
  const NON_ADAPTER_PREFIXES = ["integration.", "custom.", "custom_db."];
  if (args.tool.includes(".") && !NON_ADAPTER_PREFIXES.some((p) => args.tool.startsWith(p))) {
    try {
      const convSegment = args.conversationId || "system";
      const res = await fetch(
        `${base}/api/ai-assist/${encodeURIComponent(convSegment)}/adapter-tools/execute`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ toolFunctionName: args.tool, args: args.params }),
        },
      );
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false, error: data?.error || `adapter executor returned ${res.status}` };
      }
      // Bridge envelope: { data: { ok, output | error } }. An HTTP 200 with
      // ok:false is a provider-level failure (userErrors, missing scope,
      // not_connected, unknown_tool) and MUST fail the execution - never
      // report success on transport success alone.
      const exec = data?.data;
      if (!exec || exec.ok !== true) {
        return {
          ok: false,
          error: exec?.error || `adapter tool ${args.tool} failed`,
          result: exec ?? null,
        };
      }
      return { ok: true, result: exec.output ?? null };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? "adapter dispatch fetch failed" };
    }
  }

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

/**
 * Keep secrets out of the persisted execution result.
 *
 * `execution_result` is written to the DB and surfaced in the approvals inbox,
 * so it must carry only an outcome summary - never tokens, keys, or full
 * provider payloads that a tool happened to echo back.
 */
const SECRET_KEY_RE = /(token|secret|password|api[_-]?key|authorization|credential|refresh)/i;
export function sanitizeExecutionResult(value: unknown, depth = 0): unknown {
  if (value == null || depth > 3) return null;
  if (typeof value === "string") return value.slice(0, 500);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 10).map((v) => sanitizeExecutionResult(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? "[redacted]" : sanitizeExecutionResult(v, depth + 1);
    }
    return out;
  }
  return null;
}

const router = Router();

/**
 * Run an APPROVED action, end to end - the ONE execution path.
 *
 * Both the web approve route and the WhatsApp button handler call this, so a
 * decision made on a phone inherits the same execution state machine,
 * idempotency, failure escalation and once-only customer notification as one
 * made in the browser. Duplicating any of that per channel is how "approved on
 * WhatsApp" would quietly diverge from "approved in the app".
 *
 * Assumes the row is already APPROVED (the caller won the decision CAS).
 */
export async function runApprovedAction(opts: {
  tenantId: string;
  approvalId: string;
  conversationId: string;
  tool: string;
  params: Record<string, unknown>;
  approvedBy: string;
  authToken?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { tenantId, approvalId, conversationId, tool, params: effectiveParams, approvedBy: actorId, authToken } = opts;
  const claimed = await claimForExecution(tenantId, approvalId);
  let dispatch: { ok: boolean; error?: string; result?: unknown };
  if (!claimed) {
    dispatch = { ok: false, error: "execution_already_in_flight" };
    console.warn(`[approvals] ${approvalId} already claimed for execution - not dispatching again`);
  } else {
    // ── Business-policy REVALIDATION, after winning the claim ─────────────
    // Approval can sit pending while the world changes (another agent
    // refunded, the tenant lowered a limit, a manager edited the amount UP).
    // The same deterministic engine that gated the offer and the HITL
    // creation runs one final time - a manager's click is not an override
    // channel, and an unevaluable policy FAILS CLOSED. Running after the
    // claim means the FAILED outcome is recorded on a row we own, never over
    // a sibling's SUCCEEDED state.
    let policyBlock: string | null = null;
    try {
      const verdict = await revalidateBeforeExecution({
        tenantId,
        tool,
        params: effectiveParams,
        conversationId,
        correlationId: approvalId,
      });
      if (!verdict.ok) policyBlock = verdict.reason ?? `blocked by business policy (${verdict.decision})`;
    } catch (err: any) {
      policyBlock = `policy revalidation failed: ${err?.message ?? "unknown"}`;
    }

    dispatch = policyBlock
      ? { ok: false, error: policyBlock }
      : await dispatchApprovedAction({
          tenantId,
          approvalId: approvalId,
          conversationId: conversationId,
          tool: tool,
          params: effectiveParams,
          approvedBy: actorId,
          authToken,
        });
    // Persist the outcome BEFORE any customer messaging. The execution state
    // is now durable: a crash here leaves a row a sweeper can reason about,
    // instead of an APPROVED row that looks identical to a successful one.
    await recordExecutionOutcome(tenantId, approvalId, {
      ok: dispatch.ok,
      result: sanitizeExecutionResult(dispatch.result),
      error: dispatch.error,
    });
    if (!dispatch.ok) {
      console.error(`[approvals] dispatch failed for ${approvalId}: ${dispatch.error}`);
    }
  }

  // Customer-facing continuation: once the action succeeds, ask the AI
  // agent to continue the conversation in the customer's language. The
  // bot stays in charge - no "team member will reach out" hand-off.
  // If the oneshot fails, fall back to silence - the next inbound
  // message will trigger a normal bot turn anyway.
  // ONCE-ONLY customer continuation. Two conditions, both required:
  //   1. the action actually SUCCEEDED (execution state, not "approved"), and
  //   2. we win the notification claim - so a retry of this request, or a
  //      future resume sweeper, can never send a second "it's done".
  // The claim writes customerNotifiedAt as part of its compare-and-set.
  const mayNotify = dispatch.ok && (await claimCustomerNotification(tenantId, approvalId));
  if (mayNotify) {
    try {
      const conv = await prisma.conversation.findFirst({
        where: { id: conversationId, tenantId },
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
        where: { tenantId, conversationId: conversationId, direction: "INBOUND" },
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
        // ONE pipeline for post-execution customer messages: the AI service's
        // /execution-message endpoint runs generation through the shared
        // humanizer/style layer, validates the text against the VERIFIED
        // execution result (amounts, order, pending-vs-completed, no
        // em-dashes), and falls back to a deterministic grounded template on
        // any contradiction. No raw-oneshot path remains here on purpose.
        const r = (dispatch.result ?? {}) as Record<string, any>;
        const facts = {
          tool,
          outcome: "succeeded" as const,
          orderName: typeof r.name === "string" ? r.name : undefined,
          amount: typeof r.amount === "number" ? r.amount : undefined,
          currency: typeof r.currency === "string" ? r.currency : undefined,
          status:
            typeof r.refund_status === "string"
              ? r.refund_status
              : r.cancelled_at || r.already_cancelled
                ? "cancelled"
                : r.already_refunded
                  ? "refunded"
                  : undefined,
        };
        const aiBase = (process.env.AI_SERVICE_URL ?? "http://ai:4006").replace(/\/$/, "");
        const internalKey = getInternalServiceKey();
        try {
          const genRes = await fetch(`${aiBase}/api/ai-bot/execution-message`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Internal-Key": internalKey },
            body: JSON.stringify({
              tenantId,
              aiAgentId,
              facts,
              inboundSample,
              customerName: conv.customerName ?? undefined,
            }),
          });
          const data: any = await genRes.json().catch(() => ({}));
          if (genRes.ok && data?.reply && typeof data.reply === "string") {
            body = data.reply.trim();
          }
        } catch (err: any) {
          console.warn(
            "approvals.approve: post-execution message generation failed; staying silent:",
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
            metadata: { source: "approval_confirmation", approvalId: approvalId, tool: tool },
          },
        });
        // Audit link: which message told the customer about this approval.
        await linkCustomerMessage(tenantId, approvalId, msg.id);
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
      // Release the notification claim so the outcome can still be delivered
      // later. Safe because the ACTION already succeeded and is recorded as
      // SUCCEEDED - a retry re-sends the message only, never the action.
      await (prisma as any).approvalRequest
        .updateMany({ where: { id: approvalId, tenantId }, data: { customerNotifiedAt: null } })
        .catch(() => {});
    }
  }

  // EXECUTION FAILED: the customer must not be left with a bot that resumes
  // as though the action happened. We told them nothing (the notification is
  // gated on success), so hand the conversation to a human who can explain
  // and recover. The failure reason is durable on the row for the inbox.
  if (!dispatch.ok) {
    try {
      const conv = await prisma.conversation.findFirst({
        where: { id: conversationId, tenantId },
        select: { channel: true },
      });
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { handledBy: "human", isHandedOver: true, status: "WAITING" },
      });
      if (conv) {
        await prisma.message.create({
          data: {
            tenantId,
            conversationId: conversationId,
            channel: conv.channel,
            direction: "INBOUND",
            body: "",
            messageType: "system",
            senderName: "System",
            status: "DELIVERED",
            metadata: {
              systemEvent: "approval_execution_failed",
              approvalId: approvalId,
              tool: tool,
              error: dispatch.error ?? "execution failed",
            },
          },
        });
      }
    } catch (err: any) {
      console.error("approvals.approve: failed to escalate after execution failure:", err?.message);
    }
  }
  return { ok: dispatch.ok, error: dispatch.error };
}

// ─── Internal: run an already-APPROVED action ───────────────
//
// Called by the incoming-worker after a manager approved on WhatsApp. The
// decision was already recorded there (through the same atomic CAS the UI
// uses); this endpoint only runs the action, so both channels converge on ONE
// execution path. Service-to-service auth ONLY - registered above the user
// auth middleware because there is no user session behind a WhatsApp tap.
router.post("/:id/dispatch-approved", requireInternalKey, async (req: Request, res: Response) => {
  try {
    const tenantId = String(req.headers["x-tenant-id"] || "");
    const approvalId = req.params.id as string;
    if (!tenantId) return res.status(400).json({ error: "X-Tenant-Id required" });

    const row = await (prisma as any).approvalRequest.findFirst({
      where: { id: approvalId, tenantId },
    });
    if (!row) return res.status(404).json({ error: "approval not found" });
    // Only an APPROVED row may be executed. A rejected/expired one reaching
    // here is a bug or a replay; either way it must not run.
    if (row.status !== "APPROVED") {
      return res.status(409).json({ error: `approval is ${String(row.status).toLowerCase()}, not approved` });
    }

    const result = await runApprovedAction({
      tenantId,
      approvalId: row.id,
      conversationId: row.conversationId,
      tool: row.tool,
      params: (row.modifiedParams ?? row.params) as Record<string, unknown>,
      approvedBy: row.decidedBy ?? "whatsapp",
    });

    publishEvent({
      event: "approval:approved",
      tenantId,
      data: { approvalId: row.id, conversationId: row.conversationId, tool: row.tool, dispatchOk: result.ok, source: String(req.body?.source ?? "internal") },
    });
    return res.json({ data: { approvalId: row.id, executed: result.ok, error: result.error ?? null } });
  } catch (err: any) {
    console.error("approvals.dispatch-approved failed:", err?.message);
    return res.status(500).json({ error: "dispatch failed" });
  }
});

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

    // ATOMIC CLAIM. The PENDING/expiry checks above are a fast path for good
    // error messages; THIS is the guard that matters. Two managers clicking at
    // once (or a double-click, or web racing a WhatsApp button) previously
    // both passed the checks and both dispatched - executing the action twice.
    // Exactly one caller can win the compare-and-set; the loser stops here.
    const updated = await approveRequest(
      tenantId,
      row.id,
      actorId,
      req.body?.modifiedParams,
      req.body?.decisionReason,
      { decisionChannel: (req.body?.decisionChannel as string) || "web", correlationId: row.correlationId ?? row.id },
    );
    if (!updated) {
      // Someone else decided it (or it expired) between our read and our write.
      const current = await (prisma as any).approvalRequest.findFirst({ where: { id: row.id, tenantId }, select: { status: true } });
      return res.status(409).json({ error: `approval is already ${String(current?.status ?? "decided").toLowerCase()}` });
    }

    // Un-pause the conversation so the bot resumes on the next inbound.
    // incoming-worker continues the bot loop only on "ai_agent".
    // OWNERSHIP GUARD: if a human took the conversation over while this
    // approval sat pending (isHandedOver / assigned agent), approving the
    // action must NOT silently re-activate the bot on a human-owned
    // conversation - execute the action, keep the human in charge.
    try {
      const conv = await prisma.conversation.findFirst({
        where: { id: row.conversationId, tenantId },
        select: { isHandedOver: true, assignedAgentId: true },
      });
      if (conv && !conv.isHandedOver && !conv.assignedAgentId) {
        await prisma.conversation.update({
          where: { id: row.conversationId },
          data: { handledBy: "ai_agent" },
        });
      } else if (conv) {
        console.log(`[approvals] conversation ${row.conversationId} is human-owned - approved action runs, bot stays paused`);
      }
    } catch (err: any) {
      console.error("approvals.approve: failed to un-pause conversation:", err.message);
    }

    // Fire the approved action via the ai service executor. Best-effort:
    // failure is logged but does NOT roll back the approval record.
    const authToken = (req.headers.authorization as string | undefined) ?? undefined;

    // Claim the row for execution before dispatching. This is what stops a
    // retry sweeper (or a second request that somehow got here) from running
    // the same business action twice: only NOT_STARTED/FAILED can be claimed.
    // ONE execution path, shared with the WhatsApp approval route.
    const dispatch = await runApprovedAction({
      tenantId,
      approvalId: row.id,
      conversationId: row.conversationId,
      tool: row.tool,
      params: effectiveParams,
      approvedBy: actorId,
      authToken,
    });

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
 * POST /api/approvals/:id/retry-execution
 *
 * Safe manual retry for an approval whose EXECUTION failed (the decision
 * stands - only the action re-runs). Guarded by the same claimForExecution
 * CAS as the original dispatch: only APPROVED rows in FAILED (or stranded
 * NOT_STARTED) execution state can be claimed, so a double-click or a race
 * with the sweeper can never run the business action twice concurrently.
 */
router.post("/:id/retry-execution", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const actorId = (req as any).user?.userId ?? (req as any).user?.id;
    if (!actorId) return res.status(401).json({ error: "authentication required" });

    const row = await (prisma as any).approvalRequest.findFirst({
      where: { id: req.params.id, tenantId },
    });
    if (!row) return res.status(404).json({ error: "approval not found" });
    if (row.status !== "APPROVED") {
      return res.status(409).json({ error: `approval is ${String(row.status).toLowerCase()}, not approved` });
    }
    if (row.executionState === "SUCCEEDED" || row.executionState === "EXECUTING") {
      return res.status(409).json({ error: `execution is already ${String(row.executionState).toLowerCase()}` });
    }
    // Pre-state-machine rows: outcome unknown, action may or may not have run.
    // Re-running a years-old refund/booking on "maybe" is never safe.
    if (row.executionState === "LEGACY_UNVERIFIED") {
      return res.status(409).json({ error: "legacy approval predates execution tracking - outcome unverified, retry is not allowed" });
    }

    const result = await runApprovedAction({
      tenantId,
      approvalId: row.id,
      conversationId: row.conversationId,
      tool: row.tool,
      params: (row.modifiedParams ?? row.params) as Record<string, unknown>,
      approvedBy: row.decidedBy ?? actorId,
      authToken: (req.headers.authorization as string | undefined) ?? undefined,
    });
    publishEvent({
      event: "approval:approved",
      tenantId,
      data: { approvalId: row.id, conversationId: row.conversationId, tool: row.tool, dispatchOk: result.ok, source: "retry" },
    }).catch(() => {});
    return res.json({ data: { approvalId: row.id, executed: result.ok, error: result.error ?? null } });
  } catch (err: any) {
    console.error("approvals.retry-execution error:", err);
    return res.status(500).json({ error: "Failed to retry execution" });
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
