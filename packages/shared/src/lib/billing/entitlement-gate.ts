/**
 * The one question every paid operation has to ask: may this organization do
 * this, right now?
 *
 * Two things had to be true and only one was being checked. `checkAiAllowed`
 * answered "is this tenant commercially in good standing" and
 * `isFeatureEnabledForTenant` answered "does their plan include this" - and
 * nothing put them together, so a tenant in good standing could use a feature
 * they had never paid for, and a feature check could pass for an organization
 * that stopped paying months ago.
 *
 * This composes both, and is deliberately tenant-scoped rather than user-scoped:
 * the revenue-producing paths are background workers, inbound message handlers
 * and scheduled jobs, none of which have a signed-in user to check. A gate that
 * needs a request context is a gate those paths bypass.
 *
 * Three modes, because switching this on at once across a live product would
 * deny someone mid-conversation before anyone had seen the numbers:
 *
 *   off      answer, decide nothing
 *   audit    evaluate and report, allow anyway
 *   enforce  deny
 *
 * Production runs `enforce`. `off` in production is not a configuration, it is
 * an incident - see assertEnforcementConfigured.
 */
import { prisma } from "../prisma";
import { getBalance } from "./wallet";
// The PLAN entitlement resolver, not the permissions feature flag. The two
// answer different questions - "is this in their plan" versus "is this switched
// on for them" - and the commercial one is the one that decides billing.
import { isEntitled } from "./entitlement-resolver";
import { readPaygAccess } from "./spend-window";

export type EnforcementMode = "off" | "audit" | "enforce";

export type DenialReason =
  /** The organization itself is not in a state that permits paid use. */
  | "payment_required"
  | "tenant_suspended"
  | "no_subscription"
  | "subscription_pending"
  | "subscription_suspended"
  | "subscription_canceled"
  | "subscription_paused"
  | "trial_expired"
  | "poc_expired"
  | "past_due_grace_expired"
  /** The organization is fine; this particular capability is not included. */
  | "feature_not_in_plan"
  /** Included, but there is nothing left to spend. */
  | "credits_exhausted";

export interface PaidAccessDecision {
  allowed: boolean;
  /** True when the rules said no, whatever the mode did about it. */
  wouldDeny: boolean;
  reason?: DenialReason;
  mode: EnforcementMode;
  /** Present when the answer depended on a named capability. */
  feature?: string;
  /** Remaining credits, or null when they were not the deciding factor. */
  balance: number | null;
  detail?: string;
}

const ALLOW = (mode: EnforcementMode, balance: number | null = null): PaidAccessDecision => ({
  allowed: true,
  wouldDeny: false,
  mode,
  balance,
});

function deny(
  mode: EnforcementMode,
  reason: DenialReason,
  opts: { feature?: string; balance?: number | null; detail?: string } = {},
): PaidAccessDecision {
  return {
    // audit evaluates and reports without acting, so a rollout can be measured
    // before it starts refusing people.
    allowed: mode !== "enforce",
    wouldDeny: true,
    reason,
    mode,
    feature: opts.feature,
    balance: opts.balance ?? null,
    detail: opts.detail,
  };
}

/**
 * The configured mode.
 *
 * Older spellings are accepted so a deployment mid-rollout does not silently
 * fall to `off` - which is the one wrong answer, because it fails open.
 */
export function getEnforcementMode(env: NodeJS.ProcessEnv = process.env): EnforcementMode {
  const raw = String(env.BILLING_ENFORCEMENT_MODE || "").toLowerCase().trim();
  switch (raw) {
    case "enforce":
    case "hard":
      return "enforce";
    case "audit":
    case "observe":
    case "soft":
      return "audit";
    case "off":
      return "off";
    default:
      // Unset or unrecognised. In production this never gets here, because
      // startup refuses to boot - see assertEnforcementConfigured.
      return "off";
  }
}

/**
 * How long a failed renewal keeps working before paid use stops.
 *
 * A card expires and a customer needs a chance to fix it. Cutting them off the
 * hour a renewal fails punishes the ordinary case - an expired card - as
 * harshly as never paying.
 */
export function pastDueGraceHours(): number {
  const raw = Number(process.env.BILLING_PAST_DUE_GRACE_HOURS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 72;
}

/**
 * Refuse to start on a configuration that fails open.
 *
 * Called at boot. A missing or misspelt enforcement mode in production would
 * silently mean "off", and every organization that stopped paying would keep
 * being served with nothing to indicate it. Better to not start.
 */
export function assertEnforcementConfigured(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== "production") return;

  const raw = String(env.BILLING_ENFORCEMENT_MODE || "").trim();
  if (!raw) {
    throw new Error(
      "[billing] BILLING_ENFORCEMENT_MODE is not set. In production this would mean 'off', " +
        "and every organization that stopped paying would keep being served. Set it to 'enforce'.",
    );
  }

  const known = ["off", "audit", "enforce", "hard", "observe", "soft"];
  if (!known.includes(raw.toLowerCase())) {
    throw new Error(
      `[billing] BILLING_ENFORCEMENT_MODE='${raw}' is not a mode. A typo here fails OPEN, ` +
        `so it refuses to start instead. Expected one of: ${known.join(", ")}.`,
    );
  }

  // Resolved from the SAME env that was passed in. This used to consult
  // process.env regardless, so the function half-ignored its own argument: any
  // caller supplying an explicit environment got the mode from somewhere else,
  // and a perfectly valid "ENFORCE" was reported as "off in production".
  if (getEnforcementMode(env) === "off" && env.BILLING_ALLOW_UNENFORCED !== "true") {
    // Deliberately hard to do by accident. Running production unenforced is a
    // decision someone should have to write down.
    throw new Error(
      "[billing] BILLING_ENFORCEMENT_MODE=off in production means nobody is required to pay. " +
        "If that is genuinely intended, set BILLING_ALLOW_UNENFORCED=true to acknowledge it.",
    );
  }
}

export class PaidAccessDeniedError extends Error {
  readonly code = "PAID_ACCESS_DENIED";
  constructor(readonly decision: PaidAccessDecision) {
    super(
      `[billing] not entitled: ${decision.reason}${decision.feature ? ` (${decision.feature})` : ""}`,
    );
    this.name = "PaidAccessDeniedError";
  }
}

export interface PaidAccessQuery {
  tenantId: string;
  /** The capability being used. Omit to ask only about commercial standing. */
  feature?: string;
  /** Credits this operation will consume, if it consumes any. */
  requiredCredits?: number;
  /**
   * Ask only about commercial standing and skip the wallet.
   *
   * Opt-OUT rather than opt-in, deliberately. Making the credit check
   * conditional on the caller naming a feature meant a caller asking the plain
   * question - "may this tenant run AI" - got "yes" with an empty wallet,
   * because nothing had told the gate credits were relevant. For paid
   * operations they always are.
   */
  skipCreditCheck?: boolean;
  /**
   * Evaluate as if this mode were configured.
   *
   * Exists for the enforcement impact report, which has to answer "who would be
   * refused if we switched this on" while enforcement is still off. Without it
   * the report would have to restate the rules to predict them, and a report
   * that restates the rules eventually disagrees with them - which is worse
   * than no report, because someone will act on it.
   */
  assumeMode?: EnforcementMode;
  now?: Date;
}

/**
 * Evaluate both halves of the question.
 *
 * Order matters and is deliberate: the organization's own state first, then
 * whether the capability is included, then whether there is anything left to
 * spend. A tenant that has not paid should be told that, not told they are out
 * of credits.
 */
export async function checkPaidAccess(query: PaidAccessQuery): Promise<PaidAccessDecision> {
  const mode = query.assumeMode ?? getEnforcementMode();
  if (mode === "off") return ALLOW(mode);

  const now = query.now ?? new Date();

  let tenant: { status: string } | null = null;
  let subscription:
    | { status: string; enforcementEnabled: boolean; trialEndsAt: Date | null; currentPeriodEnd: Date | null; planKey: string; planVersion: number }
    | null = null;

  try {
    const [t, link] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: query.tenantId }, select: { status: true } }),
      prisma.billableEntityTenant.findUnique({
        where: { tenantId: query.tenantId },
        include: { entity: { include: { subscription: true } } },
      }),
    ]);
    tenant = t;
    const sub = link?.entity.subscription;
    subscription = sub
      ? {
          status: sub.status,
          enforcementEnabled: sub.enforcementEnabled,
          trialEndsAt: sub.trialEndsAt,
          currentPeriodEnd: sub.currentPeriodEnd,
          planKey: sub.planKey,
          planVersion: sub.planVersion,
        }
      : null;
  } catch {
    // A database blip must not lock every paying customer out of the product
    // they are paying for. Fails open ONLY here, and only on infrastructure.
    return ALLOW(mode);
  }

  // ── The organization's own state ──────────────────────────────────────
  if (tenant?.status === "PENDING_PAYMENT") return deny(mode, "payment_required");
  if (tenant?.status === "SUSPENDED") return deny(mode, "tenant_suspended");

  // Statuses where the paid product is already refused by the tenant access
  // matrix (see tenant-access-policy) are left alone here - but only when an
  // access source actually exists.
  //
  // This used to allow every non-ACTIVE tenant unconditionally, on the reasoning
  // that onboarding has no subscription yet and refusing it would break the one
  // flow that must work before anyone can pay. That reasoning stopped holding
  // when every organization began life with a plan: a POC or a paid checkout is
  // created WITH the tenant now, so a tenant in onboarding with no access source
  // at all is not a customer signing up, it is a tenant that should not be
  // served. And the blanket allow was reachable by background workers, which do
  // not pass through the HTTP matrix at all.
  if (tenant && tenant.status !== "ACTIVE") {
    return subscription ? ALLOW(mode) : deny(mode, "no_subscription");
  }

  // Grandfathered subscriptions have enforcement explicitly disabled. That is a
  // commercial decision recorded on the row, not an accident.
  if (subscription && !subscription.enforcementEnabled) return ALLOW(mode);

  if (!subscription) return deny(mode, "no_subscription");

  switch (subscription.status) {
    case "ACTIVE":
      break;
    case "TRIALING": {
      const ends = subscription.trialEndsAt ?? subscription.currentPeriodEnd;
      if (ends && ends <= now) return deny(mode, "trial_expired", { detail: ends.toISOString() });
      break;
    }
    case "PAST_DUE": {
      const since = subscription.currentPeriodEnd ?? now;
      const graceEnds = new Date(since.getTime() + pastDueGraceHours() * 3_600_000);
      if (now > graceEnds) {
        return deny(mode, "past_due_grace_expired", { detail: graceEnds.toISOString() });
      }
      break;
    }
    case "PENDING":
      return deny(mode, "subscription_pending");
    case "SUSPENDED":
      return deny(mode, "subscription_suspended");
    case "CANCELED":
      return deny(mode, "subscription_canceled");
    case "PAUSED":
      return deny(mode, "subscription_paused");
    case "GRANDFATHERED":
      return ALLOW(mode);
    default:
      return deny(mode, "no_subscription", { detail: subscription.status });
  }

  // A POC or trial plan carries its own expiry, separate from the subscription
  // status - an unattended POC should stop, not run forever.
  if (subscription.currentPeriodEnd && subscription.currentPeriodEnd <= now) {
    const plan = await prisma.plan
      .findUnique({
        where: { key_version: { key: subscription.planKey, version: subscription.planVersion } },
        select: { kind: true },
      })
      .catch(() => null);
    if (plan?.kind === "POC") return deny(mode, "poc_expired", { detail: subscription.currentPeriodEnd.toISOString() });
    if (plan?.kind === "TRIAL") return deny(mode, "trial_expired", { detail: subscription.currentPeriodEnd.toISOString() });
  }

  // ── Is this capability included ───────────────────────────────────────
  if (query.feature) {
    const included = await isEntitled(query.tenantId, query.feature).catch(() => true);
    if (!included) return deny(mode, "feature_not_in_plan", { feature: query.feature });
  }

  // ── Is there anything left to spend ───────────────────────────────────
  if (query.skipCreditCheck) return ALLOW(mode);

  let balance = 0;
  try {
    balance = (await getBalance(query.tenantId)).total;
  } catch {
    return ALLOW(mode, null);
  }
  if (balance <= 0 || balance < (query.requiredCredits ?? 0)) {
    // A spent wallet is not the end of the story when the organization chose
    // pay-as-you-go: the work continues and the bill arrives when the cycle
    // closes. The ceiling is what stops it, and it is checked HERE, before the
    // call runs, as well as on every accrual afterwards. Checking it only when
    // the invoice is drawn up would make it a receipt rather than a limit.
    const payg = await readPaygAccess(query.tenantId, now);
    if (payg.enabled && payg.headroom > 0) {
      return ALLOW(mode, balance);
    }
    return deny(mode, "credits_exhausted", { feature: query.feature, balance });
  }

  return ALLOW(mode, balance);
}

/** Throws when the operation must not proceed. */
export async function assertPaidAccess(query: PaidAccessQuery): Promise<PaidAccessDecision> {
  const decision = await checkPaidAccess(query);
  if (!decision.allowed) throw new PaidAccessDeniedError(decision);
  return decision;
}

/** Wording for a human deciding what to tell a customer. */
export function explainDenial(reason: DenialReason | undefined): string {
  switch (reason) {
    case "payment_required": return "The organization's plan is not active - payment has not been confirmed.";
    case "tenant_suspended": return "The organization's account is suspended.";
    case "no_subscription": return "The organization has no active subscription or approved allocation.";
    case "subscription_pending": return "The subscription exists but has not started.";
    case "subscription_suspended": return "The subscription is suspended.";
    case "subscription_canceled": return "The subscription has been canceled.";
    case "subscription_paused": return "The subscription is paused.";
    case "trial_expired": return "The trial has ended.";
    case "poc_expired": return "The proof of concept has ended.";
    case "past_due_grace_expired": return "Payment failed and the grace period has passed.";
    case "feature_not_in_plan": return "This capability is not included in the active plan.";
    case "credits_exhausted": return "No credits remain.";
    default: return "Allowed.";
  }
}
