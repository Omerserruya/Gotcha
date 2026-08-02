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
 * Did the tool say, in its own result, that nothing changed?
 *
 * The dispatch layer only knows whether the call completed. Every write tool in
 * this round reads its own change back and reports the verdict, and that verdict
 * has to outrank a clean HTTP round trip - otherwise a customer is told their
 * address changed by a message generated from the same result that says it did
 * not.
 *
 * Only an EXPLICIT negative counts. A tool that reports nothing is not claiming
 * failure, and treating silence as failure would turn every unverified-but-fine
 * write into an alarming message.
 */
export function providerReportedNoChange(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const r = result as Record<string, any>;
  const inner = (r.result ?? r.output) as Record<string, any> | undefined;
  const scopes = [r, inner].filter((s): s is Record<string, any> => !!s && typeof s === "object");
  return scopes.some(
    (s) =>
      s.verified === false ||
      s.address_updated === false ||
      s.exchange_completed === false ||
      s.return_created === false ||
      s.updated === false,
  );
}

/** A terminal HITL outcome that owes the customer exactly one message. */
type ContinuationOutcome = "succeeded" | "failed" | "rejected";

/**
 * Escalate only after the action has been tried more than once. One transient
 * provider error is not a reason to take the conversation away from an AI that
 * can still explain itself and offer the supported alternative.
 */
const MAX_AUTONOMOUS_EXECUTION_ATTEMPTS = 2;

/**
 * Collapse a raw dispatch error into a SHORT, customer-safe reason class.
 *
 * Nothing from a provider reaches a customer verbatim. "shopify_422: Cannot
 * cancel a paid and fulfilled order" is a sentence about our integration, not
 * about their order, and status codes, URLs, stack frames and internal ids are
 * all noise that erodes trust. The classes below are the only vocabulary the
 * message generator ever sees for a failure.
 */
export function toCustomerSafeReason(error?: string): string {
  const e = String(error ?? "").toLowerCase();
  if (!e) return "unknown";
  if (/already (cancelled|canceled|refunded)|already_(cancelled|canceled|refunded)/.test(e)) {
    return "already_done";
  }
  // "outstanding fulfillments" is Shopify's real refusal for an order whose
  // fulfillment work has been handed to a service. It must match here: it fell
  // through to "unknown" once, and "unknown" is the one class that gives the
  // model nothing true to say.
  if (/fulfil|shipped|dispatched/.test(e)) return "not_possible_after_shipping";
  if (/scope|permission|forbidden|401|403/.test(e)) return "not_permitted";
  if (/policy|blocked|revalidat/.test(e)) return "not_permitted";
  if (/timeout|econnrefused|enotfound|unavailable|5\d\d/.test(e)) return "provider_unavailable";
  if (/limit|exceed|maximum|too (large|many)/.test(e)) return "exceeds_limit";
  return "unknown";
}

/**
 * Last-resort customer message, used only when the AI service cannot be
 * reached. The generator owns tone and language normally; this exists so that
 * an AI outage degrades to a plain true sentence rather than to silence, which
 * is the failure mode this whole path was built to remove.
 */
function localFallbackMessage(tool: string, outcome: ContinuationOutcome, he: boolean): string {
  const isCancel = /cancel/.test(tool);
  const isRefund = /refund/.test(tool);
  const actHe = isCancel ? "הביטול" : isRefund ? "ההחזר" : "הפעולה";
  const actEn = isCancel ? "the cancellation" : isRefund ? "the refund" : "the action";
  if (outcome === "succeeded") {
    return he ? `${actHe} בוצע בהצלחה.` : `${actEn[0].toUpperCase()}${actEn.slice(1)} was completed successfully.`;
  }
  if (outcome === "rejected") {
    return he
      ? `הבקשה לא אושרה ולכן ${actHe} לא בוצע. אפשר לבדוק יחד אפשרות אחרת.`
      : `The request was not approved, so ${actEn} did not go through. We can look at another option together.`;
  }
  return he
    ? `הבקשה אושרה, אבל לא הצלחתי להשלים את ${actHe} כרגע. אני בודק את האפשרויות.`
    : `The request was approved, but I could not complete ${actEn} right now. I am checking the options.`;
}

const HEBREW_RE = /[֐-׿]/;

/**
 * The human order name from decided arguments, e.g. "#1010".
 *
 * Only a NAME - a numeric Shopify internal id is not something to read out to
 * a customer, and quoting one as though it were their order number is worse
 * than saying nothing.
 */
function orderNameFromParams(params: Record<string, unknown> | undefined): string | undefined {
  const raw = params?.order_name;
  if (typeof raw === "string" && raw.trim()) {
    const t = raw.trim();
    return t.startsWith("#") ? t : `#${t}`;
  }
  return undefined;
}

/**
 * Tell the customer what a decided approval actually did - exactly once.
 *
 * ONE function for all three terminal outcomes (succeeded / failed / rejected)
 * so a rejection cannot quietly grow different delivery, dedup or audit rules
 * than a success. The once-only guarantee is the CAS inside
 * claimCustomerNotification: it writes customerNotifiedAt as part of the claim
 * and asserts the row really is in the outcome being claimed, so no caller can
 * announce a cancellation for a row that failed, and a retry of the
 * surrounding request can never produce a second message.
 */
async function sendApprovalContinuation(args: {
  tenantId: string;
  approvalId: string;
  conversationId: string;
  tool: string;
  outcome: ContinuationOutcome;
  result?: unknown;
  errorReason?: string;
  /** The approved/rejected arguments - the only trustworthy source of the
   * order name when no provider result exists. */
  params?: Record<string, unknown>;
}): Promise<{ sent: boolean; reason?: string }> {
  const { tenantId, approvalId, conversationId, tool, outcome } = args;
  if (!conversationId) return { sent: false, reason: "no_conversation" };

  // Claim FIRST. Everything below is delivery; the claim is the thing that
  // makes "exactly one" true across retries, sweepers and both decision
  // channels (web and WhatsApp).
  const claimed = await claimCustomerNotification(tenantId, approvalId, outcome);
  if (!claimed) return { sent: false, reason: "already_notified" };

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
    if (!conv || !conv.channelAccountId || !conv.customerExternalId) {
      throw new Error("conversation is not addressable");
    }

    // A few recent inbound messages so the generator can detect the
    // conversation's language even when the latest message is language-less.
    const recentInbound = await prisma.message.findMany({
      where: { tenantId, conversationId, direction: "INBOUND" },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { body: true },
    });
    const inboundSample = recentInbound
      .map((m) => m.body?.trim())
      .filter((s): s is string => !!s)
      .reverse()
      .join("\n");

    const r = (args.result ?? {}) as Record<string, any>;
    const facts = {
      tool,
      outcome,
      // Facts are attached only for a SUCCESS. Quoting an amount or a status
      // beside "this did not happen" is how a customer concludes it did.
      // Provider result first, then the arguments that were decided on.
      // A rejection has NO result - nothing ran - and with no order name in
      // the facts the model reached into the conversation history and told the
      // customer their cancellation of order 1007 was declined when the
      // rejected request was for 1010. An approval decision must name the
      // order it actually concerned.
      orderName:
        typeof r.name === "string"
          ? r.name
          : orderNameFromParams(args.params),
      amount: outcome === "succeeded" && typeof r.amount === "number" ? r.amount : undefined,
      // A currency with no amount is not a fact, it is a stray field - and the
      // model duly rendered it as "המטבע USD" in a message that quoted no
      // money at all. Only travels with the number it denominates.
      currency:
        outcome === "succeeded" && typeof r.amount === "number" && typeof r.currency === "string"
          ? r.currency
          : undefined,
      status:
        outcome !== "succeeded"
          ? undefined
          : typeof r.refund_status === "string"
            ? r.refund_status
            : r.cancelled_at || r.already_cancelled
              ? "cancelled"
              : r.already_refunded
                ? "refunded"
                : undefined,
      errorReason: args.errorReason,
      // The reference a successful action produced, so the customer can quote
      // it back. A return opened without one is a return they cannot ask about.
      reference:
        outcome === "succeeded"
          ? (typeof r.return_name === "string" && r.return_name) ||
            (typeof r.return_id === "string" && r.return_id) ||
            null
          : null,
    };

    let body: string | null = null;
    const aiAgentId = (conv as any)?.assignedAiAgentId as string | undefined;
    if (aiAgentId) {
      const aiBase = (process.env.AI_SERVICE_URL ?? "http://ai:4006").replace(/\/$/, "");
      try {
        const genRes = await fetch(`${aiBase}/api/ai-bot/execution-message`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Internal-Key": getInternalServiceKey() },
          body: JSON.stringify({
            tenantId,
            aiAgentId,
            facts,
            inboundSample,
            customerName: conv.customerName ?? undefined,
          }),
        });
        const data: any = await genRes.json().catch(() => ({}));
        if (genRes.ok && typeof data?.reply === "string" && data.reply.trim()) {
          body = data.reply.trim();
        }
      } catch (err: any) {
        console.warn("[approvals] execution-message generation failed:", err?.message);
      }
    }
    // Degrade to a plain true sentence rather than to silence.
    if (!body) body = localFallbackMessage(tool, outcome, HEBREW_RE.test(inboundSample));

    const msg = await prisma.message.create({
      data: {
        tenantId,
        conversationId: conv.id,
        channel: conv.channel,
        direction: "OUTBOUND",
        body,
        senderName: "AI Bot",
        status: "PENDING",
        metadata: { source: "approval_continuation", approvalId, tool, outcome },
      },
    });
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
    return { sent: true };
  } catch (err: any) {
    console.error("[approvals] post-decision customer message failed:", err?.message);
    // Release the claim so a sweeper can still deliver the outcome. Safe: the
    // DECISION and any execution are already durable, so a retry re-sends the
    // message only and never re-runs the business action.
    await (prisma as any).approvalRequest
      .updateMany({ where: { id: approvalId, tenantId }, data: { customerNotifiedAt: null } })
      .catch(() => {});
    return { sent: false, reason: err?.message };
  }
}

/**
 * Return a decided conversation to the AI.
 *
 * Only from the parked `awaiting_approval` state, and only when no human has
 * taken it over in the meantime - approving an action must never yank a
 * conversation back off an agent who has since picked it up.
 */
async function restoreAiOwnership(tenantId: string, conversationId: string): Promise<void> {
  if (!conversationId) return;
  try {
    await prisma.conversation.updateMany({
      where: {
        id: conversationId,
        tenantId,
        handledBy: "awaiting_approval",
        isHandedOver: false,
        assignedAgentId: null,
      },
      data: { handledBy: "ai_agent" },
    });
  } catch (err: any) {
    console.error("[approvals] failed to return conversation to the AI:", err?.message);
  }
}

/**
 * Record a failed execution on the conversation, and hand over ONLY when the
 * AI has genuinely run out of road.
 *
 * The system message is written either way so the inbox shows what happened;
 * what is conditional is ownership. A conversation taken from the AI on the
 * first provider error is a conversation no one is answering.
 */
async function recordFailureAndMaybeEscalate(args: {
  tenantId: string;
  approvalId: string;
  conversationId: string;
  tool: string;
  error?: string;
}): Promise<{ escalated: boolean }> {
  const { tenantId, approvalId, conversationId, tool } = args;
  let escalated = false;
  try {
    const [conv, row] = await Promise.all([
      prisma.conversation.findFirst({
        where: { id: conversationId, tenantId },
        select: { channel: true },
      }),
      (prisma as any).approvalRequest.findFirst({
        where: { id: approvalId, tenantId },
        select: { executionAttempts: true },
      }),
    ]);

    const attempts = Number(row?.executionAttempts ?? 1);
    const reason = toCustomerSafeReason(args.error);
    // "already_done" is not a failure the customer needs a human for - the
    // world is already in the state they asked for, and the AI can say so.
    escalated = reason !== "already_done" && attempts >= MAX_AUTONOMOUS_EXECUTION_ATTEMPTS;

    if (escalated) {
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { handledBy: "human", isHandedOver: true, status: "WAITING" },
      });
    }

    if (conv) {
      await prisma.message.create({
        data: {
          tenantId,
          conversationId,
          channel: conv.channel,
          direction: "INBOUND",
          body: "",
          messageType: "system",
          senderName: "System",
          status: "DELIVERED",
          metadata: {
            systemEvent: "approval_execution_failed",
            approvalId,
            tool,
            error: args.error ?? "execution failed",
            reasonClass: reason,
            attempts,
            escalated,
          },
        },
      });
    }
  } catch (err: any) {
    console.error("[approvals] failed to record execution failure:", err?.message);
  }
  return { escalated };
}

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
    // A tool that RAN is not a tool that did the thing. This has to be folded
    // in HERE, not only at the continuation: `claimCustomerNotification`
    // asserts the row really is in the outcome being claimed, so persisting
    // SUCCEEDED and then claiming a "failed" continuation matches nothing and
    // the customer gets NO message at all - which is the exact silent failure
    // Part 1 was written to end, reintroduced from the other side.
    const noChange = providerReportedNoChange(dispatch.result);
    // Persist the outcome BEFORE any customer messaging. The execution state
    // is now durable: a crash here leaves a row a sweeper can reason about,
    // instead of an APPROVED row that looks identical to a successful one.
    await recordExecutionOutcome(tenantId, approvalId, {
      ok: dispatch.ok && !noChange,
      result: sanitizeExecutionResult(dispatch.result),
      error: dispatch.error ?? (noChange ? "provider_reported_no_change" : undefined),
    });
    if (!dispatch.ok) {
      console.error(`[approvals] dispatch failed for ${approvalId}: ${dispatch.error}`);
    }
  }

  // ── Customer-facing continuation ─────────────────────────────────────
  // EVERY decided approval owes the customer exactly one message, whether the
  // action succeeded or failed. Gating this on success is precisely what left
  // a customer who had just been told "I'm handling your cancellation now" in
  // total silence when Shopify refused, with the conversation then dumped on a
  // human who had no idea what had been promised.
  // Live (2026-08-02): an approved address change dispatched cleanly, and the
  // tool's own read-back reported `verified: false` - so the continuation told
  // the customer their address had been changed on the strength of
  // `dispatch.ok` alone, while the result sitting beside it said the opposite.
  // Tools that verify themselves are believed over the transport.
  const unverified = providerReportedNoChange(dispatch.result);
  await sendApprovalContinuation({
    tenantId,
    approvalId,
    conversationId,
    tool,
    outcome: dispatch.ok && !unverified ? "succeeded" : "failed",
    result: dispatch.result,
    params: effectiveParams,
    errorReason: dispatch.ok
      ? unverified
        ? "the change could not be confirmed on the order afterwards"
        : undefined
      : toCustomerSafeReason(dispatch.error),
  });

  // ── Ownership after a failed execution ───────────────────────────────
  // Handoff is NOT a generic error handler. The customer has now been told the
  // truth, and the AI still holds the order, the request and the reason it
  // failed - enough to offer the action that DOES work (a fulfilled order that
  // cannot be cancelled takes a return plus a refund). Escalate only once the
  // action has genuinely been attempted more than once without success.
  let escalated = false;
  if (!dispatch.ok) {
    ({ escalated } = await recordFailureAndMaybeEscalate({
      tenantId,
      approvalId,
      conversationId,
      tool,
      error: dispatch.error,
    }));
  }

  // ── Back to the AI ───────────────────────────────────────────────────
  // The conversation was parked at handledBy="awaiting_approval" when the
  // approval was raised, and nothing moved it back. The web approve route
  // un-parked it, but the WhatsApp/internal dispatch route did not - so an
  // approval decided on a phone left the conversation frozen in a state the
  // incoming-worker does not treat as bot-owned, and the customer's NEXT
  // message got no reply at all. Restoring it here means every decision
  // channel converges on the same end state.
  if (!escalated) await restoreAiOwnership(tenantId, conversationId);
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

/**
 * POST /api/approvals/:id/dispatch-rejected  (internal, no user session)
 *
 * The rejection counterpart of dispatch-approved. A manager who taps "reject"
 * on WhatsApp recorded the decision through the same atomic CAS as the web UI
 * - and then the customer heard nothing at all, because the continuation and
 * the ownership reset lived only in the web route's handler. The approve path
 * had already been unified behind one endpoint for exactly this reason; the
 * reject path had not, so "declined on a phone" and "declined in the app" were
 * two different products.
 */
router.post("/:id/dispatch-rejected", requireInternalKey, async (req: Request, res: Response) => {
  try {
    const tenantId = String(req.headers["x-tenant-id"] || "");
    const approvalId = req.params.id as string;
    if (!tenantId) return res.status(400).json({ error: "X-Tenant-Id required" });

    const row = await (prisma as any).approvalRequest.findFirst({
      where: { id: approvalId, tenantId },
    });
    if (!row) return res.status(404).json({ error: "approval not found" });
    // Only a genuinely rejected row may produce a rejection message. Anything
    // else arriving here is a replay or a bug, and must not tell a customer
    // their request was declined when it was not.
    if (row.status !== "REJECTED") {
      return res.status(409).json({ error: `approval is ${String(row.status).toLowerCase()}, not rejected` });
    }

    const sent = await sendApprovalContinuation({
      tenantId,
      approvalId: row.id,
      conversationId: row.conversationId,
      tool: row.tool,
      outcome: "rejected",
      params: (row.modifiedParams ?? row.params) as Record<string, unknown>,
    });
    await restoreAiOwnership(tenantId, row.conversationId);

    return res.json({ data: { approvalId: row.id, notified: sent.sent, reason: sent.reason ?? null } });
  } catch (err: any) {
    console.error("approvals.dispatch-rejected failed:", err?.message);
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
    if (!updated) {
      const current = await (prisma as any).approvalRequest.findFirst({
        where: { id: row.id, tenantId },
        select: { status: true },
      });
      return res.status(409).json({ error: `approval is already ${String(current?.status ?? "decided").toLowerCase()}` });
    }

    // A rejection is a DECISION, not an incident. Nothing was attempted, so
    // there is nothing for a human to clean up - the AI keeps the conversation,
    // tells the customer the request was not approved and offers what IS
    // supported. Routing every "no" to a person was the reason a declined
    // cancellation looked, to the customer, exactly like being ignored.
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
      }
    } catch (err: any) {
      console.error("approvals.reject: failed to resume conversation:", err.message);
    }

    // Proactive rejection message - same once-only claim as every other
    // outcome, so the customer never has to send another message to find out
    // what happened to their request.
    await sendApprovalContinuation({
      tenantId,
      approvalId: row.id,
      conversationId: row.conversationId,
      tool: row.tool,
      outcome: "rejected",
      params: (row.modifiedParams ?? row.params) as Record<string, unknown>,
    });

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
