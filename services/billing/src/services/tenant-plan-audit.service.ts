/**
 * The estate-wide answer to "does every organization have a plan".
 *
 * The invariant is enforced going forward at creation and at every request, but
 * that says nothing about the tenants that already exist - and those are the
 * ones the rule was written for. A tenant created before the rule can sit ACTIVE
 * with no subscription indefinitely, and nothing in the product would say so.
 *
 * This is deliberately a REPORT and not a backfill. Assigning a paid plan to an
 * organization that never chose one would invent a commercial agreement, and
 * granting credits to make a tenant look healthy is the same mistake with a
 * different unit. What a no-plan tenant needs is a decision by a human, so this
 * produces the list and the actions, and stops.
 *
 * Batched: a few queries for the whole estate rather than one per tenant, so it
 * stays usable when it matters, which is when the estate is large.
 */
import { prisma, resolveTenantPlanAccessBatch, type PlanAccessVerdict } from "@chatcenter/shared";

export interface TenantPlanAuditRow {
  tenantId: string;
  name: string;
  slug: string;
  tenantStatus: string;
  createdAt: Date;
  verdict: PlanAccessVerdict;
  /** What a Sysadmin can do about it, when there is anything to do. */
  actions: ("ASSIGN_PAID_PLAN" | "PROVISION_POC" | "REPAIR_SETUP" | "RESEND_PAYMENT_LINK" | "MANUAL_REVIEW")[];
}

export type TenantPlanAuditGroup =
  | "ACTIVE_PAID"
  | "ACTIVE_POC"
  | "ACTIVE_TRIAL"
  | "ACTIVE_MANUAL_CONTRACT"
  | "PENDING_PAYMENT"
  | "SETUP_INCOMPLETE"
  | "EXPIRED"
  | "CONFLICTING"
  | "MISSING";

export interface TenantPlanAuditReport {
  generatedAt: Date;
  total: number;
  counts: Record<TenantPlanAuditGroup, number>;
  groups: Record<TenantPlanAuditGroup, TenantPlanAuditRow[]>;
  /** Every tenant a human has to decide something about. */
  requiresReview: TenantPlanAuditRow[];
  /** True when no tenant is unaccounted for. */
  invariantHolds: boolean;
}

const EMPTY_GROUPS = (): Record<TenantPlanAuditGroup, TenantPlanAuditRow[]> => ({
  ACTIVE_PAID: [], ACTIVE_POC: [], ACTIVE_TRIAL: [], ACTIVE_MANUAL_CONTRACT: [],
  PENDING_PAYMENT: [], SETUP_INCOMPLETE: [], EXPIRED: [], CONFLICTING: [], MISSING: [],
});

function actionsFor(verdict: PlanAccessVerdict): TenantPlanAuditRow["actions"] {
  switch (verdict.state) {
    case "PENDING_PAYMENT":
      return ["RESEND_PAYMENT_LINK"];
    case "SETUP_INCOMPLETE":
      return ["REPAIR_SETUP", "MANUAL_REVIEW"];
    case "CONFLICTING":
      // Never resolved automatically. Which plan is the real one is a
      // commercial fact this code does not have.
      return ["MANUAL_REVIEW"];
    case "EXPIRED":
    case "MISSING":
      return ["ASSIGN_PAID_PLAN", "PROVISION_POC"];
    default:
      return [];
  }
}

export async function auditTenantPlans(opts: { now?: Date } = {}): Promise<TenantPlanAuditReport> {
  const now = opts.now ?? new Date();

  // The SAME resolver the request gate uses. An audit that reimplemented the
  // rules would eventually disagree with them, and the disagreement would look
  // like a clean report over an estate that was actually being denied.
  const [tenants, verdicts] = await Promise.all([
    prisma.tenant.findMany({
      select: { id: true, name: true, slug: true, status: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    resolveTenantPlanAccessBatch(undefined, { now }),
  ]);

  const groups = EMPTY_GROUPS();
  const rows: TenantPlanAuditRow[] = [];

  for (const tenant of tenants) {
    const verdict = verdicts.get(tenant.id);
    if (!verdict) continue;
    const row: TenantPlanAuditRow = {
      tenantId: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      tenantStatus: tenant.status,
      createdAt: tenant.createdAt,
      verdict,
      actions: actionsFor(verdict),
    };
    rows.push(row);
    groups[verdict.state as TenantPlanAuditGroup].push(row);
  }

  const counts = Object.fromEntries(
    Object.entries(groups).map(([k, v]) => [k, v.length]),
  ) as Record<TenantPlanAuditGroup, number>;

  const requiresReview = rows.filter((r) => r.verdict.needsReview);

  return {
    generatedAt: now,
    total: rows.length,
    counts,
    groups,
    requiresReview,
    // Every tenant is either holding access, awaiting payment for a plan it
    // chose, repairable, or explicitly flagged. There is no fifth outcome - a
    // tenant in none of those would be one the classifier could not place, and
    // the classifier is total.
    invariantHolds: rows.every(
      (r) => r.verdict.active || r.verdict.state === "PENDING_PAYMENT" || r.verdict.needsReview,
    ),
  };
}
