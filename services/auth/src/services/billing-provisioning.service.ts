/**
 * The cross-service provisioning saga.
 *
 * Tenant creation lives in auth; BillableEntity, PendingCheckout and
 * PaymentAttempt live in billing. They cannot share a transaction without
 * breaking service ownership, so this makes the REQUEST durable instead.
 *
 * That record is what turns a billing failure from a dead end into a
 * recoverable state. Before it existed, a failed call left the tenant in
 * PENDING_PAYMENT with the requested plan stored nowhere: resend could not
 * recreate a checkout it had never seen, and retrying creation was blocked by
 * slug uniqueness. Nothing could move the tenant forward.
 *
 * Retry safety comes from a deterministic idempotency key derived from this
 * request. Billing keys both the checkout and the initial payment attempt on
 * it, so any number of repairs converge on one set of records.
 */
import { prisma, writeAudit, AuditAction } from "@chatcenter/shared";
import type { BillingProvisioningState } from "@prisma/client";

/**
 * Resolved at CALL time, not module load.
 *
 * A module-level const is captured once, which makes the value untestable and
 * silently ignores any runtime configuration change - the same trap as a
 * captured feature flag.
 */
function billingServiceUrl(): string {
  return process.env.BILLING_SERVICE_URL || "http://billing:4009";
}

/** Bounded. A permanently invalid request must not be retried forever. */
export const MAX_PROVISIONING_ATTEMPTS = 5;

/**
 * Failure codes that retrying cannot fix.
 *
 * A retired plan or an invalid volume key will fail identically every time, so
 * retrying only burns attempts and hides the real problem from the operator.
 */
const PERMANENT_FAILURES = new Set([
  // POC selections that are wrong rather than unlucky: an unknown domain or a
  // past expiry will be just as wrong on the fifth attempt.
  "unknown_feature_domain",
  "expiry_must_be_in_the_future",
  "credit_budget_required",
  "tenant_not_found",
  "plan_version_not_found",
  "plan_version_not_active",
  "plan_version_not_selectable",
  "plan_version_not_public",
  "plan_version_belongs_to_another_organization",
  "volume_option_invalid",
  "volume_option_not_enabled",
  "billing_interval_mismatch",
  "client_supplied_commercial_value",
]);

export function classifyFailure(code: string | undefined): BillingProvisioningState {
  return code && PERMANENT_FAILURES.has(code) ? "FAILED_PERMANENT" : "FAILED_RETRYABLE";
}

export interface BillingSelection {
  /** Defaults to PAID_PLAN, which is what every caller meant before POC existed. */
  mode?: "PAID_PLAN" | "POC";
  planVersionId?: string | null;
  chatVolumeOptionKey?: string | null;
  voiceVolumeOptionKey?: string | null;
  billingInterval?: string | null;
  commercialNote?: string | null;
  /** POC only. */
  pocCredits?: number | null;
  pocExpiresAt?: Date | null;
  pocFeatureAreas?: string[] | null;
}

/** Persist the request BEFORE billing is called, so a failure is recoverable. */
export async function createProvisioningRequest(args: {
  tenantId: string;
  requestedBy?: string | null;
  selection: BillingSelection;
}) {
  const mode = args.selection.mode ?? "PAID_PLAN";
  const request = await prisma.tenantBillingProvisioningRequest.create({
    data: {
      tenantId: args.tenantId,
      requestedBy: args.requestedBy ?? null,
      mode,
      planVersionId: args.selection.planVersionId ?? null,
      chatVolumeOptionKey: args.selection.chatVolumeOptionKey ?? null,
      voiceVolumeOptionKey: args.selection.voiceVolumeOptionKey ?? null,
      billingInterval: args.selection.billingInterval ?? null,
      commercialNote: args.selection.commercialNote ?? null,
      pocCredits: args.selection.pocCredits ?? null,
      pocExpiresAt: args.selection.pocExpiresAt ?? null,
      pocFeatureAreas: args.selection.pocFeatureAreas ?? [],
      // Placeholder, replaced below with a key derived from the row's own id
      // so it is deterministic for this request and nothing else.
      idempotencyKey: `provisioning:pending:${args.tenantId}:${Date.now()}`,
      state: "PENDING",
    },
  });

  const updated = await prisma.tenantBillingProvisioningRequest.update({
    where: { id: request.id },
    data: { idempotencyKey: `provisioning:${request.id}` },
  });

  void writeAudit({
    tenantId: args.tenantId,
    actorType: "user",
    actorId: args.requestedBy ?? undefined,
    action: AuditAction.BILLING_PROVISIONING_REQUEST_CREATED,
    targetType: "provisioning_request",
    targetId: updated.id,
    metadata: { mode, planVersionId: args.selection.planVersionId ?? null, pocCredits: args.selection.pocCredits ?? null },
  });

  return updated;
}

export interface ProvisioningOutcome {
  ok: boolean;
  state: BillingProvisioningState;
  body?: any;
  failureCode?: string;
}

/**
 * Run (or re-run) provisioning for a durable request.
 *
 * Safe to call repeatedly: billing converges on the deterministic key, and a
 * COMPLETED request short-circuits rather than calling billing again.
 */
export async function runProvisioning(requestId: string): Promise<ProvisioningOutcome> {
  const request = await prisma.tenantBillingProvisioningRequest.findUnique({ where: { id: requestId } });
  if (!request) return { ok: false, state: "FAILED_PERMANENT", failureCode: "request_not_found" };
  if (request.state === "COMPLETED") {
    return { ok: true, state: "COMPLETED", body: { alreadyCompleted: true } };
  }
  if (request.state === "CANCELLED") {
    return { ok: false, state: "CANCELLED", failureCode: "request_cancelled" };
  }
  if (request.attemptCount >= MAX_PROVISIONING_ATTEMPTS && request.state !== "FAILED_PERMANENT") {
    return { ok: false, state: request.state, failureCode: "max_attempts_exhausted" };
  }

  // Claim it. The conditional update stops two operators (or an operator and
  // the background retry) both calling billing for the same request.
  const claimed = await prisma.tenantBillingProvisioningRequest.updateMany({
    where: { id: requestId, state: { in: ["PENDING", "FAILED_RETRYABLE"] } },
    data: { state: "PROCESSING", lastAttemptAt: new Date(), attemptCount: { increment: 1 } },
  });
  if (claimed.count !== 1) {
    return { ok: false, state: request.state, failureCode: "already_processing" };
  }

  void writeAudit({
    tenantId: request.tenantId, actorType: "system",
    action: AuditAction.BILLING_PROVISIONING_ATTEMPTED,
    targetType: "provisioning_request", targetId: request.id,
    metadata: { attempt: request.attemptCount + 1 },
  });

  // Two destinations, one saga. A POC and a paid plan differ in what billing
  // does, not in how a cross-service failure is made recoverable, so both run
  // through the same claim, retry classification and repair path.
  const poc = request.mode === "POC";
  const endpoint = poc ? "setup-poc" : "provision-paid-tenant";
  const payload = poc
    ? {
        tenantId: request.tenantId,
        credits: request.pocCredits,
        expiresAt: request.pocExpiresAt ? request.pocExpiresAt.toISOString() : null,
        features: request.pocFeatureAreas?.length ? request.pocFeatureAreas : null,
        note: request.commercialNote,
        actor: request.requestedBy,
      }
    : {
        tenantId: request.tenantId,
        planVersionId: request.planVersionId,
        chatVolumeOptionKey: request.chatVolumeOptionKey,
        voiceVolumeOptionKey: request.voiceVolumeOptionKey,
        billingInterval: request.billingInterval ?? undefined,
        commercialNote: request.commercialNote,
        actor: request.requestedBy,
        idempotencyKey: request.idempotencyKey,
      };

  let res: { ok: boolean; body: any };
  try {
    const httpRes = await fetch(`${billingServiceUrl()}/api/internal/billing/${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Key": process.env.INTERNAL_SERVICE_KEY || "",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    res = { ok: httpRes.ok, body: await httpRes.json().catch(() => ({})) };
  } catch (err: any) {
    res = { ok: false, body: { error: "billing_unreachable", message: err?.message } };
  }

  if (!res.ok) {
    const code = String(res.body?.error ?? "provisioning_failed");
    const state = classifyFailure(code);
    await prisma.tenantBillingProvisioningRequest.update({
      where: { id: requestId },
      data: {
        state,
        lastFailureCode: code,
        // Sanitized: a transport or provider message is never stored verbatim.
        lastFailureMessage: safeMessage(code, state, request.mode),
        nextRetryAt: state === "FAILED_RETRYABLE" ? nextBackoff(request.attemptCount + 1) : null,
      },
    });
    void writeAudit({
      tenantId: request.tenantId, actorType: "system",
      action: AuditAction.BILLING_PROVISIONING_FAILED,
      targetType: "provisioning_request", targetId: request.id,
      metadata: { failureCode: code, state },
    });
    return { ok: false, state, failureCode: code };
  }

  await prisma.tenantBillingProvisioningRequest.update({
    where: { id: requestId },
    data: {
      state: "COMPLETED",
      checkoutId: res.body?.checkoutId ?? null,
      completedAt: new Date(),
      nextRetryAt: null,
      lastFailureCode: null,
      lastFailureMessage: null,
    },
  });
  void writeAudit({
    tenantId: request.tenantId, actorType: "system",
    action: AuditAction.BILLING_PROVISIONING_COMPLETED,
    targetType: "provisioning_request", targetId: request.id,
    metadata: { checkoutReference: res.body?.checkoutReference, created: res.body?.created },
  });

  return { ok: true, state: "COMPLETED", body: res.body };
}

/** Operator-safe message. Never a raw transport or provider string. */
function safeMessage(code: string, state: BillingProvisioningState, mode = "PAID_PLAN"): string {
  if (state === "FAILED_PERMANENT") {
    return mode === "POC"
      ? "The POC settings are not valid. Correct the credit budget, expiry or feature areas and provision again."
      : "The selected plan or volume option is no longer valid. Choose a different plan and provision again.";
  }
  if (code === "billing_unreachable") {
    return "The billing service could not be reached. This is usually temporary; retry the setup.";
  }
  return "Billing setup did not complete. Retry the setup.";
}

/** Bounded exponential backoff: 1, 2, 4, 8, 16 minutes. */
function nextBackoff(attempt: number): Date {
  const minutes = Math.min(2 ** Math.max(0, attempt - 1), 16);
  return new Date(Date.now() + minutes * 60_000);
}

/** The safe, operator-facing view of a tenant's provisioning state. */
export async function provisioningStatusForTenant(tenantId: string) {
  const request = await prisma.tenantBillingProvisioningRequest.findFirst({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
  });
  if (!request) return null;
  return {
    id: request.id,
    state: request.state,
    mode: request.mode,
    planVersionId: request.planVersionId,
    attemptCount: request.attemptCount,
    lastAttemptAt: request.lastAttemptAt,
    lastFailureCode: request.lastFailureCode,
    lastFailureMessage: request.lastFailureMessage,
    // Repair is for a request that never completed; resend is for one that did.
    canRepair: request.state === "PENDING" || request.state === "FAILED_RETRYABLE",
    canResend: request.state === "COMPLETED",
  };
}
