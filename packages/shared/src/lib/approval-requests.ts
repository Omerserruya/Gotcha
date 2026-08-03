/**
 * Approval request helpers for the bot-surface F4 flow.
 *
 * Used from the bot engine when evaluateToolGate() returns
 * REQUIRE_APPROVAL. The bot pauses the conversation, creates a rich
 * request, and surfaces it in-inbox to a human agent via a banner in
 * the conversation view.
 *
 * See memory/bug_f4_approval_wrong_surface.md for the design.
 */
import { createHash } from "node:crypto";
import { prisma } from "./prisma";
import { publishEvent } from "./event-bus";
import { reportOperationalFailure, recordExpectedOutcome } from "./observability/operational-failure";
import { ERROR_CODES } from "./observability/error-codes";
import type { ToolGateResult } from "./tool-gate";

/**
 * Deterministic fingerprint of a BUSINESS operation.
 *
 * Row-level once-only guards proved insufficient in production: two approval
 * rows both describing "refund order #1004" each won their own notification
 * claim and the customer was told twice. The key names the operation itself.
 *
 * Every governed write tool defines its own CANONICAL idempotency projection:
 * exactly the fields that identify the business operation, nothing cosmetic.
 * Getting this wrong in either direction is costly - too coarse and a second
 * LEGITIMATE partial refund on the same order is swallowed; too fine and a
 * retried duplicate mints a second approval. Notes per tool:
 *
 *   cancel_order       - an order can be cancelled exactly once, so the order
 *                        alone identifies it (reason/restock are execution
 *                        options, not identity).
 *   process_refund     - one order takes MANY legitimate refunds over time, so
 *                        identity = order + amount (or "full") + sorted line
 *                        items×quantities + shipping flag + restock flag +
 *                        currency when supplied. A shipping-only refund, an
 *                        item refund, a partial and the later full-remaining
 *                        refund all key differently; an exact duplicate keys
 *                        identically. Replay safety for UNCERTAIN retries does
 *                        not rely on this key: the adapter reconciles current
 *                        Shopify state first (prior refunds consume remaining
 *                        quantities, requests are capped at the gateway's
 *                        refundable maximum, fully-refunded orders return
 *                        already_refunded without a second mutation).
 *   coupon tools       - the CODE is the business object (Shopify does not
 *                        enforce cross-rule uniqueness; the adapter also
 *                        dedups by lookup before create).
 *
 * Unknown tools fall back to a hash of ALL normalized params: only ever
 * UNDER-dedups (identical requests still match), never swallows a distinct
 * operation.
 */
function norm(v: unknown): string {
  return String(v ?? "").trim().toLowerCase().replace(/^#/, "");
}

type OperationProjection = (p: Record<string, any>) => string;

const byCode: OperationProjection = (p) => `code=${norm(p.code)}`;
const byOrder: OperationProjection = (p) => `order=${norm(p.order_id ?? p.order_name)}`;

const OPERATION_PROJECTIONS: Record<string, OperationProjection> = {
  "shopify.cancel_order": byOrder,
  "shopify.process_refund": (p) => {
    const items = Array.isArray(p.line_items)
      ? p.line_items
          .map((li: any) => `${norm(li?.line_item_id)}x${Number(li?.quantity ?? 1)}`)
          .sort()
          .join("+")
      : "";
    const amount = p.amount != null && Number.isFinite(Number(p.amount))
      ? Number(p.amount).toFixed(2)
      : "full-remaining";
    return [
      byOrder(p),
      `amount=${amount}`,
      `items=${items || (p.amount != null ? "amount-only" : "all-remaining")}`,
      `shipping=${p.refund_shipping != null ? String(!!p.refund_shipping) : "default"}`,
      `restock=${!!p.restock}`,
      ...(p.currency ? [`cur=${norm(p.currency)}`] : []),
    ].join("&");
  },
  "shopify.issue_compensation_coupon": byCode,
  "shopify.create_discount_code": byCode,
  "shopify.create_one_time_coupon": byCode,
  "shopify.create_vip_coupon": byCode,
  "shopify.disable_coupon": byCode,
  "shopify.send_invoice": byOrder,
};

export function computeOperationKey(
  tool: string,
  params: Record<string, unknown> | null | undefined,
): string {
  const p = (params ?? {}) as Record<string, any>;
  const project = OPERATION_PROJECTIONS[tool];
  const identity = project
    ? project(p)
    : createHash("sha256")
        .update(Object.keys(p).sort().map((k) => `${k}=${norm(p[k])}`).join("&"))
        .digest("hex")
        .slice(0, 24);
  return `${tool}:${identity}`;
}

export interface CreateApprovalRequestInput {
  tenantId: string;
  /** Optional: System Copilot plans aren't always conversation-scoped
   * (e.g. "build a workflow"). Customer-facing approvals always set this. */
  conversationId?: string;
  contactId?: string;
  messageId?: string;
  tool: string;
  params: Record<string, unknown>;
  summary: string;      // one-sentence natural language for the card
  reason: string;       // bot's own reasoning for the card
  riskLevel?: "low" | "medium" | "high";
  riskTags?: string[];
  requestedBy: string;  // "bot" | "flow:<id>" | "ai-agent:<id>"
  gate?: ToolGateResult;
  /**
   * Kernel resume envelope (P1-3/B6). Set by the Capability Runtime's approval
   * gate: the FULL ExecutionRequest so approval-resume re-enters the Runtime
   * (invariants apply on HITL writes). Absent for legacy-brain requests.
   */
  resumeEnvelope?: {
    kind: "kernel_operation";
    operation: string;
    params: Record<string, unknown>;
    context: Record<string, unknown>;
    mode: string;
  };
}

export async function createApprovalRequest(
  input: CreateApprovalRequestInput,
): Promise<{ id: string; expiresAt: Date; deduped?: boolean }> {
  const expiresAfterMin = input.gate?.approvalConfig?.expiresAfterMin ?? 30;
  const expiresAt = new Date(Date.now() + expiresAfterMin * 60 * 1000);
  const operationKey = computeOperationKey(input.tool, input.params);

  // BUSINESS-OPERATION dedup: if this exact operation already has an open
  // request (awaiting decision, awaiting/being executed, or already done),
  // return that row instead of minting a sibling. Terminal dead ends
  // (REJECTED / EXPIRED / execution FAILED / LEGACY_UNVERIFIED) do NOT block -
  // a fresh legitimate attempt after a failure must stay possible.
  const open = await (prisma as any).approvalRequest.findFirst({
    where: {
      tenantId: input.tenantId,
      operationKey,
      OR: [
        { status: "PENDING", expiresAt: { gt: new Date() } },
        { status: "APPROVED", executionState: { in: ["NOT_STARTED", "EXECUTING", "SUCCEEDED"] } },
      ],
    },
    select: { id: true, expiresAt: true },
    orderBy: { createdAt: "desc" },
  });
  if (open) {
    // Dedupe working as designed: the same action asked twice reuses one
    // approval instead of minting a sibling. Expected, so a breadcrumb.
    recordExpectedOutcome("hitl_request_deduped", { tool: input.tool });
    return { id: open.id, expiresAt: open.expiresAt, deduped: true };
  }

  let created: { id: string; expiresAt: Date; conversationId: string | null; tool: string; summary: string; riskLevel: string; requestedBy: string; createdAt: Date };
  try {
    created = await (prisma as any).approvalRequest.create({
    data: {
      tenantId: input.tenantId,
      conversationId: input.conversationId ?? null,
      contactId: input.contactId ?? null,
      messageId: input.messageId ?? null,
      tool: input.tool,
      params: input.params as any,
      summary: input.summary,
      reason: input.reason,
      policyRuleId: null,
      policyRuleName: input.gate?.reason ?? null,
      riskLevel: input.riskLevel ?? "medium",
      riskTags: (input.riskTags ?? []) as any,
      status: "PENDING",
      requestedBy: input.requestedBy,
      resumeEnvelope: (input.resumeEnvelope as any) ?? null,
      operationKey,
      expiresAt,
    },
    select: { id: true, expiresAt: true, conversationId: true, tool: true, summary: true, riskLevel: true, requestedBy: true, createdAt: true },
    });
  } catch (err) {
    // The action is gated and there is now no way to approve it. The turn is
    // stuck and no human will ever be asked - the quietest possible failure,
    // which is precisely why it is reported rather than only thrown.
    reportOperationalFailure({
      errorCode: ERROR_CODES.hitl_request_creation_failed,
      domain: "hitl", service: "shared",
      cause: err,
      context: { tool: input.tool, riskLevel: input.riskLevel ?? "medium" },
    });
    throw err;
  }

  // Surface as a tenant-scoped socket event so the Approvals page (and any
  // open inbox view) can render live without polling.
  await publishEvent({
    event: "approval:created",
    tenantId: input.tenantId,
    data: {
      id: created.id,
      conversationId: created.conversationId,
      tool: created.tool,
      summary: created.summary,
      riskLevel: created.riskLevel,
      requestedBy: created.requestedBy,
      createdAt: created.createdAt,
      expiresAt: created.expiresAt,
    },
  }).catch(() => {});
  return { id: created.id, expiresAt: created.expiresAt };
}

export async function findPendingByConversation(
  tenantId: string,
  conversationId: string,
) {
  return (prisma as any).approvalRequest.findMany({
    where: { tenantId, conversationId, status: "PENDING" },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Grant an approval ATOMICALLY.
 *
 * This is a compare-and-set, not a plain update, and that is the whole point:
 * the route used to read the row, check PENDING, then update - a textbook
 * TOCTOU. Two managers (or one double-click, or a web click racing a WhatsApp
 * button) both saw PENDING and both dispatched, so the action ran twice. A
 * refund or a booking running twice is a real-money bug.
 *
 * The `where` carries tenantId AND the expected status, so exactly one caller
 * can win. Losers get `null` and must NOT dispatch.
 *
 * Also note tenantId is part of the predicate - the old helper accepted it and
 * then ignored it, leaving cross-tenant writes fenced only by an earlier read.
 *
 * @returns the updated row for the winner, or null if someone else decided it.
 */
export async function approveRequest(
  tenantId: string,
  id: string,
  decidedBy: string,
  modifiedParams?: Record<string, unknown>,
  decisionReason?: string,
  opts?: { decisionChannel?: string; correlationId?: string },
): Promise<any | null> {
  const now = new Date();
  const claimed = await (prisma as any).approvalRequest.updateMany({
    // Expired rows are excluded here too, so a late click on a stale
    // notification cannot approve something whose TTL has passed even if the
    // sweeper has not yet flipped it to EXPIRED.
    where: { id, tenantId, status: "PENDING", expiresAt: { gt: now } },
    data: {
      status: "APPROVED",
      decidedBy,
      decidedAt: now,
      decisionReason: decisionReason ?? null,
      modifiedParams: modifiedParams ?? null,
      decisionChannel: opts?.decisionChannel ?? null,
      correlationId: opts?.correlationId ?? null,
    },
  });
  if (claimed.count === 0) return null;
  return (prisma as any).approvalRequest.findFirst({ where: { id, tenantId } });
}

/**
 * Claim an approved request for execution. Same CAS discipline: only a row
 * that is APPROVED and NOT_STARTED (or a previously FAILED one being retried)
 * can move to EXECUTING, so a retry sweeper can never race the inline dispatch
 * into running the same action twice.
 *
 * @returns the claimed row, or null when another worker already has it.
 */
export async function claimForExecution(tenantId: string, id: string): Promise<any | null> {
  const claimed = await (prisma as any).approvalRequest.updateMany({
    where: { id, tenantId, status: "APPROVED", executionState: { in: ["NOT_STARTED", "FAILED"] } },
    data: { executionState: "EXECUTING", executionStartedAt: new Date(), executionAttempts: { increment: 1 } },
  });
  if (claimed.count === 0) return null;
  return (prisma as any).approvalRequest.findFirst({ where: { id, tenantId } });
}

/** Record the outcome of a dispatch. `result` must already be sanitized. */
export async function recordExecutionOutcome(
  tenantId: string,
  id: string,
  outcome: { ok: boolean; result?: unknown; error?: string },
): Promise<void> {
  await (prisma as any).approvalRequest.updateMany({
    where: { id, tenantId },
    data: {
      executionState: outcome.ok ? "SUCCEEDED" : "FAILED",
      executionEndedAt: new Date(),
      executionResult: (outcome.result ?? null) as any,
      executionError: outcome.ok ? null : (outcome.error ?? "execution failed"),
    },
  });
}

/**
 * Which terminal HITL outcome a customer continuation is being claimed for.
 *
 * EVERY decision owes the customer exactly one message. Previously only
 * `succeeded` could be claimed, so an approval that was rejected, or that was
 * approved and then failed to execute, told the customer nothing at all - the
 * conversation simply went silent and was dumped on a human. The claim is what
 * makes "exactly one" true for all three, not just the happy path.
 */
export type ContinuationOutcome = "succeeded" | "failed" | "rejected";

/** CAS predicate per outcome: the row must genuinely BE in that state. */
const CONTINUATION_PREDICATE: Record<ContinuationOutcome, Record<string, unknown>> = {
  // Only a provider-confirmed action may produce a "we did it" message.
  succeeded: { status: "APPROVED", executionState: "SUCCEEDED" },
  // Approved, dispatched, and the action did not happen.
  failed: { status: "APPROVED", executionState: "FAILED" },
  // A human said no. Execution never ran, so executionState is irrelevant.
  rejected: { status: "REJECTED" },
};

/**
 * Claim the right to tell the customer, exactly once.
 *
 * The `customerNotifiedAt` timestamp is written as part of the claim, so a
 * retry of the surrounding job cannot produce a second message. Delivery
 * itself is retried by the outbound queue, which re-sends the SAME message row
 * rather than re-running this claim.
 *
 * The predicate always asserts the row is really in the claimed outcome, so a
 * caller cannot send "your order was cancelled" for a row that failed.
 */
export async function claimCustomerNotification(
  tenantId: string,
  id: string,
  outcome: ContinuationOutcome = "succeeded",
): Promise<boolean> {
  // OPERATION-level guard: if a SIBLING row for the same business operation
  // already told the customer it SUCCEEDED, this row must stay silent - the
  // row-level CAS below cannot see across rows, and two rows both claiming
  // produced two "your refund is done" messages in production.
  //
  // Scoped to `succeeded` deliberately. A rejection or a failure on one row is
  // NOT made redundant by a sibling's message: refusing to speak because some
  // other row for the same operation once spoke is how a customer ends up
  // never hearing that THIS request was declined.
  if (outcome === "succeeded") {
    const row = await (prisma as any).approvalRequest.findFirst({
      where: { id, tenantId },
      select: { operationKey: true },
    });
    if (row?.operationKey) {
      const siblingNotified = await (prisma as any).approvalRequest.findFirst({
        where: {
          tenantId,
          operationKey: row.operationKey,
          id: { not: id },
          customerNotifiedAt: { not: null },
        },
        select: { id: true },
      });
      if (siblingNotified) return false;
    }
  }
  const claimed = await (prisma as any).approvalRequest.updateMany({
    where: { id, tenantId, ...CONTINUATION_PREDICATE[outcome], customerNotifiedAt: null },
    data: { customerNotifiedAt: new Date() },
  });
  return claimed.count > 0;
}

/** Attach the outbound message that carried the outcome (audit trail). */
export async function linkCustomerMessage(tenantId: string, id: string, messageId: string): Promise<void> {
  await (prisma as any).approvalRequest.updateMany({
    where: { id, tenantId },
    data: { customerMessageId: messageId },
  });
}

/**
 * Reject ATOMICALLY - same CAS discipline as approve, so an approve and a
 * reject arriving together cannot both win (and the action can never run
 * after a rejection was recorded).
 *
 * @returns the updated row, or null when the request was already decided.
 */
export async function rejectRequest(
  tenantId: string,
  id: string,
  decidedBy: string,
  decisionReason: string,
  opts?: { decisionChannel?: string; correlationId?: string },
): Promise<any | null> {
  const claimed = await (prisma as any).approvalRequest.updateMany({
    where: { id, tenantId, status: "PENDING" },
    data: {
      status: "REJECTED",
      decidedBy,
      decidedAt: new Date(),
      decisionReason,
      decisionChannel: opts?.decisionChannel ?? null,
      correlationId: opts?.correlationId ?? null,
    },
  });
  if (claimed.count === 0) return null;
  return (prisma as any).approvalRequest.findFirst({ where: { id, tenantId } });
}
