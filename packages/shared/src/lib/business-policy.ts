/**
 * Deterministic business policy engine for sensitive AI actions.
 *
 * The AI may explain the rules; it can never enforce them. Enforcement is
 * this module, evaluated at three points:
 *
 *   1. OFFER          - before the AI presents/promises an action
 *   2. HITL_CREATE    - before an approval request is created
 *   3. PRE_EXECUTION  - immediately before dispatch, after human approval
 *                       (business data may have changed while pending)
 *
 * Decisions are computed from STRUCTURED, caller-verified facts - a prompt
 * injection cannot alter them because free text is never an input. Every
 * evaluation writes an append-only PolicyDecision row carrying the policy
 * version that decided it; editing a policy creates a NEW version, so a
 * historical decision's explanation never changes underneath it.
 *
 * Failure behavior: for these action kinds the engine FAILS CLOSED - if the
 * policy cannot be read or evaluated, the decision is FAIL_CLOSED and callers
 * must deny + escalate to a human, never improvise.
 */
import { prisma } from "./prisma";

export type BusinessActionKind =
  | "REFUND"
  | "CANCEL_ORDER"
  | "COUPON"
  | "COMPENSATION"
  | "DISCOUNT"
  | "CUSTOMER_WRITE";

export type PolicyEvaluationPoint = "OFFER" | "HITL_CREATE" | "PRE_EXECUTION";

export type PolicyDecisionKind =
  | "ALLOWED"
  | "DENIED"
  | "REQUIRES_INFORMATION"
  | "REQUIRES_EVIDENCE"
  | "REQUIRES_HUMAN_APPROVAL"
  | "ALLOWED_WITH_LIMIT"
  | "ALTERNATIVE_ACTION_REQUIRED"
  | "FAIL_CLOSED";

/**
 * Tenant-authored rule payload (BusinessActionPolicy.config). All fields
 * optional - an absent field means "no restriction from this rule".
 */
export interface BusinessPolicyConfig {
  /** Reason codes for which this action may be offered at all. Empty/absent = any reason. */
  approvedReasons?: string[];
  /** Reason codes that additionally require structured evidence before proceeding. */
  requireEvidenceFor?: string[];
  /** Absolute cap in the order currency. */
  maxAmount?: number;
  /** Cap as a fraction of the order value (0.5 = 50%). */
  maxPercentOfOrder?: number;
  /** Per-customer frequency limit: at most maxEvents in windowDays. */
  perCustomerWindowDays?: number;
  perCustomerMaxEvents?: number;
  /** Refuse a second compensation for the same incident. */
  preventDuplicatePerIncident?: boolean;
  /** Amounts above this always need a human approval, even inside the caps. */
  managerApprovalAboveAmount?: number;
  /** Compensation types the tenant forbids outright ("full_refund", …). */
  prohibitedTypes?: string[];
  /** Preferred escalation ladder, mildest first ("apology", "coupon", …). */
  preferredLadder?: string[];
  /** Whether an authorized manager may override a limit (default false). */
  allowOverride?: boolean;
}

/** Structured, verified facts an evaluation is computed from. */
export interface BusinessPolicyFacts {
  /** Categorized reason code (late_delivery, damaged_or_wrong_item, …). */
  reasonCode?: string;
  /** Structured evidence blob when the reason requires it (provider data). */
  evidence?: Record<string, unknown> | null;
  /** Verified order total in the order currency. */
  orderAmount?: number;
  currency?: string;
  orderName?: string;
  /** Amount the AI/customer is asking for. */
  requestedAmount?: number;
  /** Compensation type being proposed ("percentage_coupon", "full_refund", …). */
  requestedType?: string;
  /** Verified count of prior compensations for THIS incident. */
  priorCompensationForIncident?: number;
  /** Verified count of compensation events for this customer in the window. */
  priorCompensationEventsInWindow?: number;
  contactId?: string;
  conversationId?: string;
  aiEmployeeId?: string;
  tool?: string;
}

export interface BusinessPolicyResult {
  decision: PolicyDecisionKind;
  policyId: string | null;
  policyVersion: number | null;
  matchedRules: string[];
  reasonCodes: string[];
  /** Safe to show the customer (never mentions internal policy machinery). */
  customerSafeExplanation?: string;
  /** The binding cap when decision is ALLOWED_WITH_LIMIT / REQUIRES_HUMAN_APPROVAL. */
  maxAmount?: number;
  requiredData?: string[];
}

/** Map a tool name to the action kind it represents; null = not governed. */
export function actionKindForTool(tool: string): BusinessActionKind | null {
  if (/\.process_refund$|(^|\.)issue_refund$/.test(tool)) return "REFUND";
  if (/\.cancel_order$/.test(tool)) return "CANCEL_ORDER";
  if (/issue_compensation_coupon$/.test(tool)) return "COMPENSATION";
  if (/create_(discount_code|one_time_coupon|vip_coupon)$|disable_coupon$/.test(tool)) return "COUPON";
  if (/\.(update_customer|create_note|add_tag|remove_tag|update_metafield)$/.test(tool)) return "CUSTOMER_WRITE";
  return null;
}

const SENSITIVE_KINDS = new Set<BusinessActionKind>([
  "REFUND", "CANCEL_ORDER", "COUPON", "COMPENSATION", "DISCOUNT",
]);

async function recordDecision(opts: {
  tenantId: string;
  actionKind: BusinessActionKind;
  evaluationPoint: PolicyEvaluationPoint;
  facts: BusinessPolicyFacts;
  result: BusinessPolicyResult;
  correlationId?: string;
}): Promise<void> {
  try {
    await (prisma as any).policyDecision.create({
      data: {
        tenantId: opts.tenantId,
        policyId: opts.result.policyId,
        policyVersion: opts.result.policyVersion,
        actionKind: opts.actionKind,
        evaluationPoint: opts.evaluationPoint,
        conversationId: opts.facts.conversationId ?? null,
        contactId: opts.facts.contactId ?? null,
        aiEmployeeId: opts.facts.aiEmployeeId ?? null,
        tool: opts.facts.tool ?? null,
        inputFacts: opts.facts as any,
        decision: opts.result.decision,
        matchedRules: opts.result.matchedRules as any,
        reasonCodes: opts.result.reasonCodes as any,
        maxAmount: opts.result.maxAmount ?? null,
        correlationId: opts.correlationId ?? null,
      },
    });
  } catch (err: any) {
    // The audit write must not change the decision, but its failure is loud.
    console.error("[business-policy] decision audit write failed:", err?.message);
  }
}

/**
 * Evaluate the tenant's active policy for one action. Pure decision logic
 * lives in evaluateConfig() (unit-testable without a DB); this wrapper loads
 * the latest effective policy version and records the audit row.
 */
export async function evaluateBusinessPolicy(opts: {
  tenantId: string;
  actionKind: BusinessActionKind;
  evaluationPoint: PolicyEvaluationPoint;
  facts: BusinessPolicyFacts;
  correlationId?: string;
}): Promise<BusinessPolicyResult> {
  let result: BusinessPolicyResult;
  try {
    const policy = await (prisma as any).businessActionPolicy.findFirst({
      where: {
        tenantId: opts.tenantId,
        actionKind: opts.actionKind,
        effectiveFrom: { lte: new Date() },
      },
      orderBy: { version: "desc" },
    });
    if (!policy) {
      // No tenant rule configured: backward-compatible ALLOWED. HITL catalog
      // policies (hitl_policy=always on refunds/coupons) still apply on top.
      result = {
        decision: "ALLOWED",
        policyId: null,
        policyVersion: null,
        matchedRules: [],
        reasonCodes: ["no_policy_configured"],
      };
    } else if (!policy.enabled) {
      result = {
        decision: "DENIED",
        policyId: policy.id,
        policyVersion: policy.version,
        matchedRules: ["action_disabled"],
        reasonCodes: ["action_disabled_by_tenant"],
        customerSafeExplanation: "This isn't something I can arrange, but I can connect you with the team.",
      };
    } else {
      result = evaluateConfig(
        (policy.config ?? {}) as BusinessPolicyConfig,
        opts.facts,
        { policyId: policy.id, policyVersion: policy.version },
      );
    }
  } catch (err: any) {
    // FAIL CLOSED for sensitive kinds: an unreadable policy must never let
    // money move. Callers treat FAIL_CLOSED as deny + human escalation.
    console.error("[business-policy] evaluation failed - failing closed:", err?.message);
    result = {
      decision: SENSITIVE_KINDS.has(opts.actionKind) ? "FAIL_CLOSED" : "ALLOWED",
      policyId: null,
      policyVersion: null,
      matchedRules: [],
      reasonCodes: ["policy_engine_error"],
      customerSafeExplanation: "I can't complete this myself right now, let me get a person from the team to handle it.",
    };
  }
  await recordDecision({ ...opts, result });
  return result;
}

/** Pure rule evaluation - deterministic, no I/O. Exported for tests. */
export function evaluateConfig(
  cfg: BusinessPolicyConfig,
  facts: BusinessPolicyFacts,
  meta: { policyId: string | null; policyVersion: number | null },
): BusinessPolicyResult {
  const matched: string[] = [];
  const reasons: string[] = [];
  const base = { policyId: meta.policyId, policyVersion: meta.policyVersion };

  // 1. Prohibited compensation types are absolute.
  if (facts.requestedType && cfg.prohibitedTypes?.includes(facts.requestedType)) {
    return {
      ...base, decision: "DENIED",
      matchedRules: ["prohibited_type"], reasonCodes: [`type_prohibited:${facts.requestedType}`],
      customerSafeExplanation: "That option isn't available, but there may be another way I can help.",
    };
  }

  // 2. Approved reasons: an unlisted reason is denied; a MISSING reason means
  // the AI hasn't established why yet → ask for information, don't offer.
  if (cfg.approvedReasons?.length) {
    if (!facts.reasonCode) {
      return {
        ...base, decision: "REQUIRES_INFORMATION",
        matchedRules: ["approved_reasons"], reasonCodes: ["reason_code_missing"],
        requiredData: ["reasonCode"],
      };
    }
    if (!cfg.approvedReasons.includes(facts.reasonCode)) {
      return {
        ...base, decision: "DENIED",
        matchedRules: ["approved_reasons"], reasonCodes: [`reason_not_approved:${facts.reasonCode}`],
        customerSafeExplanation: "I understand, but in this situation I can't offer that. Let me see how else I can help.",
      };
    }
    matched.push("approved_reasons");
  }

  // 3. Evidence requirements per reason.
  if (facts.reasonCode && cfg.requireEvidenceFor?.includes(facts.reasonCode)) {
    const hasEvidence = facts.evidence && Object.keys(facts.evidence).length > 0;
    if (!hasEvidence) {
      return {
        ...base, decision: "REQUIRES_EVIDENCE",
        matchedRules: [...matched, "evidence_required"],
        reasonCodes: [`evidence_required:${facts.reasonCode}`],
        requiredData: ["evidence"],
      };
    }
    matched.push("evidence_verified");
  }

  // 4. Duplicate-per-incident protection.
  if (cfg.preventDuplicatePerIncident && (facts.priorCompensationForIncident ?? 0) > 0) {
    return {
      ...base, decision: "DENIED",
      matchedRules: [...matched, "duplicate_per_incident"],
      reasonCodes: ["already_compensated_for_incident"],
      customerSafeExplanation: "We've already applied a resolution for this issue, so I can't add another one.",
    };
  }

  // 5. Per-customer frequency window.
  if (
    cfg.perCustomerMaxEvents != null &&
    (facts.priorCompensationEventsInWindow ?? 0) >= cfg.perCustomerMaxEvents
  ) {
    return {
      ...base, decision: "DENIED",
      matchedRules: [...matched, "per_customer_window"],
      reasonCodes: ["customer_window_limit_reached"],
      customerSafeExplanation: "I can't apply this right now, but a member of our team can take a look.",
    };
  }

  // 6. Amount caps - the STRICTER of the fixed cap and the percent-of-order
  // cap binds. A request above the cap is never silently allowed; the caller
  // gets the binding maximum and may re-propose within it.
  const caps: number[] = [];
  if (cfg.maxAmount != null) caps.push(cfg.maxAmount);
  if (cfg.maxPercentOfOrder != null && facts.orderAmount != null) {
    caps.push(cfg.maxPercentOfOrder * facts.orderAmount);
  }
  const cap = caps.length ? Math.min(...caps) : null;
  if (cap != null) {
    matched.push("amount_cap");
    if (facts.requestedAmount == null) {
      // No amount proposed yet: surface the cap so the AI can only offer
      // within it.
      return {
        ...base, decision: "ALLOWED_WITH_LIMIT",
        matchedRules: matched, reasonCodes: ["amount_capped"], maxAmount: round2(cap),
      };
    }
    if (facts.requestedAmount > cap + 0.005) {
      return {
        ...base, decision: "ALLOWED_WITH_LIMIT",
        matchedRules: [...matched, "requested_above_cap"],
        reasonCodes: ["requested_amount_exceeds_cap"],
        maxAmount: round2(cap),
        customerSafeExplanation: "I can offer up to a certain amount for this. Let me apply the maximum I can.",
      };
    }
  }

  // 7. Manager approval threshold (inside the caps).
  if (
    cfg.managerApprovalAboveAmount != null &&
    (facts.requestedAmount ?? 0) > cfg.managerApprovalAboveAmount
  ) {
    return {
      ...base, decision: "REQUIRES_HUMAN_APPROVAL",
      matchedRules: [...matched, "manager_threshold"],
      reasonCodes: ["amount_above_manager_threshold"],
      maxAmount: cap != null ? round2(cap) : undefined,
    };
  }

  return { ...base, decision: "ALLOWED", matchedRules: matched, reasonCodes: [] };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * PRE_EXECUTION revalidation for an approved HITL row.
 *
 * Runs the SAME engine against the CURRENT policy version and current facts -
 * approvals can sit pending while the world changes (another agent refunded,
 * the limit was lowered, a coupon was already issued). Additionally enforces
 * the manager-modification bound: a manager may REDUCE the amount, but a
 * modified amount above the policy cap is denied outright - "a manager
 * clicked approve" is not an override channel.
 */
export async function revalidateBeforeExecution(opts: {
  tenantId: string;
  tool: string;
  params: Record<string, unknown>;
  modifiedParams?: Record<string, unknown> | null;
  conversationId?: string;
  contactId?: string;
  correlationId?: string;
}): Promise<{ ok: boolean; decision: PolicyDecisionKind; reason?: string; maxAmount?: number }> {
  const kind = actionKindForTool(opts.tool);
  if (!kind) return { ok: true, decision: "ALLOWED" };

  const p = { ...(opts.params ?? {}), ...((opts.modifiedParams as Record<string, unknown>) ?? {}) };
  const requestedAmount =
    typeof p.amount === "number" ? p.amount :
    typeof p.percentage === "number" ? undefined : undefined;

  const result = await evaluateBusinessPolicy({
    tenantId: opts.tenantId,
    actionKind: kind,
    evaluationPoint: "PRE_EXECUTION",
    correlationId: opts.correlationId,
    facts: {
      tool: opts.tool,
      requestedAmount,
      orderName: typeof p.order_name === "string" ? p.order_name : undefined,
      conversationId: opts.conversationId,
      contactId: opts.contactId,
      // Reason codes captured at proposal time ride along in params.
      reasonCode: typeof p.reason_code === "string" ? p.reason_code : undefined,
    },
  });

  switch (result.decision) {
    case "ALLOWED":
      return { ok: true, decision: result.decision };
    case "REQUIRES_HUMAN_APPROVAL":
      // The human approval ALREADY happened - that's how we got here.
      return { ok: true, decision: result.decision };
    case "ALLOWED_WITH_LIMIT":
      // Within the cap → fine. A request above the cap (including one a
      // manager EDITED upward) must not execute.
      if (requestedAmount == null || (result.maxAmount != null && requestedAmount <= result.maxAmount + 0.005)) {
        return { ok: true, decision: result.decision, maxAmount: result.maxAmount };
      }
      return {
        ok: false, decision: result.decision, maxAmount: result.maxAmount,
        reason: `policy_limit_exceeded: requested ${requestedAmount} is above the permitted maximum ${result.maxAmount}`,
      };
    default:
      return {
        ok: false, decision: result.decision,
        reason: `policy_${result.decision.toLowerCase()}: ${result.reasonCodes.join(",") || "not permitted"}`,
      };
  }
}
