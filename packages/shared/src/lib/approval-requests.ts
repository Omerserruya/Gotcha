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
import type { ToolGateResult } from "./tool-gate";

/**
 * Deterministic fingerprint of a BUSINESS operation.
 *
 * Row-level once-only guards proved insufficient in production: two approval
 * rows both describing "refund order #1004" each won their own notification
 * claim and the customer was told twice. The key names the operation itself.
 *
 * Per-tool identifying args are an allowlist so cosmetic differences (reason
 * text, notes, notify flags) do not defeat the dedup; unknown tools fall back
 * to a hash of ALL params, which can only under-dedup, never over-dedup.
 */
const OPERATION_IDENTITY_KEYS: Record<string, string[]> = {
  "shopify.cancel_order": ["order_id", "order_name"],
  "shopify.process_refund": ["order_id", "order_name", "amount"],
  "shopify.issue_compensation_coupon": ["code"],
  "shopify.create_discount_code": ["code"],
  "shopify.create_one_time_coupon": ["code"],
  "shopify.create_vip_coupon": ["code"],
  "shopify.disable_coupon": ["code"],
};

function normalizeIdentityValue(v: unknown): string {
  return String(v ?? "").trim().toLowerCase().replace(/^#/, "");
}

export function computeOperationKey(
  tool: string,
  params: Record<string, unknown> | null | undefined,
): string {
  const p = params ?? {};
  const identityKeys = OPERATION_IDENTITY_KEYS[tool];
  let identity: string;
  if (identityKeys) {
    identity = identityKeys
      .map((k) => `${k}=${normalizeIdentityValue((p as any)[k])}`)
      .filter((s) => !s.endsWith("="))
      .join("&");
  } else {
    const sorted = Object.keys(p).sort().map((k) => `${k}=${normalizeIdentityValue((p as any)[k])}`);
    identity = createHash("sha256").update(sorted.join("&")).digest("hex").slice(0, 24);
  }
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
  if (open) return { id: open.id, expiresAt: open.expiresAt, deduped: true };

  const created = await (prisma as any).approvalRequest.create({
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
 * Claim the right to tell the customer, exactly once.
 *
 * Only a SUCCEEDED action with no `customerNotifiedAt` may be claimed. The
 * timestamp is written as part of the claim, so a retry of the surrounding
 * job cannot produce a second "your refund is done" message. Delivery itself
 * is retried by the outbound queue, which re-sends the SAME message row rather
 * than re-running this claim.
 */
export async function claimCustomerNotification(tenantId: string, id: string): Promise<boolean> {
  // OPERATION-level guard first: if a SIBLING row for the same business
  // operation already told the customer, this row must stay silent - the
  // row-level CAS below cannot see across rows. (Read-then-claim is safe
  // here: the worst race is two rows claiming concurrently, which the
  // creation-time dedup already makes rare, and each still passes its own
  // row CAS - strictly better than the old behavior of always double-sending.)
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
  const claimed = await (prisma as any).approvalRequest.updateMany({
    where: { id, tenantId, status: "APPROVED", executionState: "SUCCEEDED", customerNotifiedAt: null },
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
