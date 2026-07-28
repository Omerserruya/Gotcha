/**
 * The tenant-commercial invariant: every organization has exactly one plan.
 *
 * Before this, "may this organization use the product" was answered by
 * TenantStatus alone, and TenantStatus knows nothing about money. An ACTIVE
 * tenant with no subscription - a legacy row, a half-finished provisioning, a
 * POC someone cancelled - passed every HTTP gate in the product and looked
 * perfectly healthy in the console. The commercial gate caught it later, at the
 * AI runtime, which is the worst place to discover it: the tenant is already
 * inside, mid-conversation, in front of their own customer.
 *
 * So access needs BOTH answers - the tenant's own state, and whether an access
 * source actually exists - and they have to be the same two answers everywhere.
 * That is what lives here.
 *
 * The classifier is deliberately PURE. The rules that decide whether an
 * organization is entitled to the product should be readable and testable
 * without a database, and every caller - the middleware, the console, the audit
 * - reaches the same verdict from the same inputs rather than each restating
 * "and also check that the POC has not expired".
 */

/** How an organization is entitled to the product right now. */
export type PlanAccessSource =
  | "PAID"
  | "POC"
  | "TRIAL"
  | "MANUAL_CONTRACT"
  /** No access source. The distinction is WHY - see `state`. */
  | "NONE";

/**
 * The operator-facing state. Never an empty field: an organization is always in
 * exactly one of these, including the bad ones.
 */
export type PlanAccessState =
  | "ACTIVE_PAID"
  | "ACTIVE_POC"
  | "ACTIVE_TRIAL"
  | "ACTIVE_MANUAL_CONTRACT"
  /** A paid plan was selected and the first payment is not confirmed. */
  | "PENDING_PAYMENT"
  /** Plan setup was requested and never finished. Repairable. */
  | "SETUP_INCOMPLETE"
  /** There WAS access and it ended: expired POC/trial, cancelled subscription. */
  | "EXPIRED"
  /** More than one active access source. Never resolved silently. */
  | "CONFLICTING"
  /** Nothing at all. Requires a Sysadmin decision. */
  | "MISSING";

export interface PlanAccessSubscription {
  id?: string;
  planKey: string;
  planVersion: number;
  /** SubscriptionStatus. Kept as a string so this file needs no Prisma import. */
  status: string;
  /** PlanKind of the plan this subscription is on, when it could be resolved. */
  planKind?: string | null;
  planName?: string | null;
  enforcementEnabled?: boolean;
  trialEndsAt?: Date | null;
  currentPeriodEnd?: Date | null;
}

export interface PlanAccessInput {
  /** TenantStatus. */
  tenantStatus: string;
  /**
   * Every subscription reachable from this tenant.
   *
   * A list, not one row, even though the schema allows only one per billable
   * entity: the audit has to be able to REPORT a tenant that somehow has two,
   * and a signature that cannot express the anomaly cannot report it.
   */
  subscriptions: PlanAccessSubscription[];
  /** An unpaid checkout exists (PENDING / AWAITING_PROVIDER / TOKENIZED). */
  hasOpenCheckout?: boolean;
  /** A durable provisioning request exists and has not COMPLETED. */
  provisioningIncomplete?: boolean;
  /** A settled external contract paid for this subscription. */
  hasManualContract?: boolean;
  /** Hours a failed renewal keeps working. Mirrors the entitlement gate. */
  pastDueGraceHours?: number;
  now?: Date;
}

export interface PlanAccessVerdict {
  /** True only when the organization may use the paid product right now. */
  active: boolean;
  source: PlanAccessSource;
  state: PlanAccessState;
  /** Short operator-facing label. Never empty. */
  label: string;
  planKey: string | null;
  planName: string | null;
  expiresAt: Date | null;
  subscriptionId: string | null;
  /** Set when a human has to decide something. */
  needsReview: boolean;
  /** Machine-readable reason, for the audit report and tests. */
  reviewReason?: "no_plan" | "multiple_active_sources" | "expired_access" | "setup_incomplete";
}

const LABELS: Record<PlanAccessState, string> = {
  ACTIVE_PAID: "Paid plan",
  ACTIVE_POC: "POC",
  ACTIVE_TRIAL: "Trial",
  ACTIVE_MANUAL_CONTRACT: "Manual contract",
  PENDING_PAYMENT: "Pending payment",
  SETUP_INCOMPLETE: "Plan setup incomplete",
  EXPIRED: "Expired access",
  CONFLICTING: "Multiple active plans, requires review",
  MISSING: "Missing plan, requires action",
};

/**
 * Is this subscription, on its own, currently an access source?
 *
 * Mirrors the entitlement gate's ordering exactly - if these two disagree, one
 * of them lets an organization into a product the other says they may not use.
 */
export function subscriptionIsActiveSource(
  sub: PlanAccessSubscription,
  now: Date,
  graceHours: number,
): boolean {
  switch (sub.status) {
    case "ACTIVE":
      break;
    case "TRIALING": {
      const ends = sub.trialEndsAt ?? sub.currentPeriodEnd;
      if (ends && ends <= now) return false;
      break;
    }
    case "PAST_DUE": {
      // A failed renewal is not the same as never paying. The grace window is
      // the entitlement gate's, not a second opinion about it.
      const since = sub.currentPeriodEnd ?? now;
      if (now > new Date(since.getTime() + graceHours * 3_600_000)) return false;
      break;
    }
    case "GRANDFATHERED":
      // Enforcement is explicitly off. A commercial decision on the row.
      return true;
    default:
      // PENDING, SUSPENDED, CANCELED, PAUSED and anything new.
      return false;
  }

  // An evaluation carries its own expiry independent of its status. A POC left
  // ACTIVE past its window is not access, it is an unattended pilot.
  if ((sub.planKind === "POC" || sub.planKind === "TRIAL") && sub.currentPeriodEnd && sub.currentPeriodEnd <= now) {
    return false;
  }
  return true;
}

function sourceOf(
  sub: PlanAccessSubscription,
  hasManualContract: boolean,
): Exclude<PlanAccessSource, "NONE"> {
  if (sub.planKind === "POC") return "POC";
  if (sub.planKind === "TRIAL" || sub.status === "TRIALING") return "TRIAL";
  // Provenance, not plan shape: a manual contract runs on an ordinary paid plan
  // and differs only in how the money arrived.
  return hasManualContract ? "MANUAL_CONTRACT" : "PAID";
}

const STATE_FOR_SOURCE: Record<Exclude<PlanAccessSource, "NONE">, PlanAccessState> = {
  PAID: "ACTIVE_PAID",
  POC: "ACTIVE_POC",
  TRIAL: "ACTIVE_TRIAL",
  MANUAL_CONTRACT: "ACTIVE_MANUAL_CONTRACT",
};

/**
 * Decide an organization's commercial access from facts alone.
 *
 * Order matters: a real access source wins, then the recoverable states in the
 * order an operator can act on them, then the ones needing a decision. A tenant
 * that is merely awaiting payment must not be reported as "missing plan" - the
 * action for one is "wait or resend", for the other it is "choose a plan".
 */
export function classifyTenantPlanAccess(input: PlanAccessInput): PlanAccessVerdict {
  const now = input.now ?? new Date();
  const graceHours = input.pastDueGraceHours ?? 72;
  const subs = input.subscriptions ?? [];

  const activeSubs = subs.filter((s) => subscriptionIsActiveSource(s, now, graceHours));

  // More than one live access source is never resolved by picking one. Which
  // one is right is a commercial question, and guessing it silently is how an
  // organization ends up billed for a plan nobody chose.
  if (activeSubs.length > 1) {
    return {
      active: false,
      source: "NONE",
      state: "CONFLICTING",
      label: LABELS.CONFLICTING,
      planKey: null,
      planName: null,
      expiresAt: null,
      subscriptionId: null,
      needsReview: true,
      reviewReason: "multiple_active_sources",
    };
  }

  if (activeSubs.length === 1) {
    const sub = activeSubs[0]!;
    const source = sourceOf(sub, input.hasManualContract === true);
    const state = STATE_FOR_SOURCE[source];
    return {
      active: true,
      source,
      state,
      label: source === "PAID" || source === "MANUAL_CONTRACT" ? (sub.planName || sub.planKey) : LABELS[state],
      planKey: sub.planKey,
      planName: sub.planName ?? null,
      expiresAt: sub.currentPeriodEnd ?? null,
      subscriptionId: sub.id ?? null,
      needsReview: false,
    };
  }

  const base = {
    active: false as const,
    source: "NONE" as const,
    planKey: subs[0]?.planKey ?? null,
    planName: subs[0]?.planName ?? null,
    expiresAt: subs[0]?.currentPeriodEnd ?? null,
    subscriptionId: subs[0]?.id ?? null,
  };

  // Selected a paid plan, has not paid. A PendingCheckout is emphatically not a
  // plan - it is the intention to have one - but it is also not "missing", and
  // telling an operator to choose a plan for a tenant that already has one
  // waiting sends them to do the wrong thing.
  if (input.tenantStatus === "PENDING_PAYMENT" && input.hasOpenCheckout) {
    return { ...base, state: "PENDING_PAYMENT", label: LABELS.PENDING_PAYMENT, needsReview: false };
  }

  // Asked for, never finished. Repairable, and the durable request holds what
  // was requested, so the operator re-enters nothing.
  if (input.provisioningIncomplete) {
    return {
      ...base,
      state: "SETUP_INCOMPLETE",
      label: LABELS.SETUP_INCOMPLETE,
      needsReview: true,
      reviewReason: "setup_incomplete",
    };
  }

  // A PENDING_PAYMENT tenant with neither a checkout nor a request is a tenant
  // whose plan was recorded nowhere. That is setup that did not complete.
  if (input.tenantStatus === "PENDING_PAYMENT") {
    return {
      ...base,
      state: "SETUP_INCOMPLETE",
      label: LABELS.SETUP_INCOMPLETE,
      needsReview: true,
      reviewReason: "setup_incomplete",
    };
  }

  if (subs.length > 0) {
    return {
      ...base,
      state: "EXPIRED",
      label: LABELS.EXPIRED,
      needsReview: true,
      reviewReason: "expired_access",
    };
  }

  return { ...base, state: "MISSING", label: LABELS.MISSING, needsReview: true, reviewReason: "no_plan" };
}

/** The label for a state, for surfaces that hold a state and not a verdict. */
export function planAccessLabel(state: PlanAccessState): string {
  return LABELS[state];
}
