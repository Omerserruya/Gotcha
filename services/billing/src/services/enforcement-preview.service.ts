/**
 * Who would stop being served if enforcement were switched on.
 *
 * Enforcement mode is a single environment variable that changes what happens to
 * live customer conversations. Flipping it to `hard` without knowing the blast
 * radius means finding out from the organizations whose bots went quiet - and
 * the ones most likely to be affected are exactly the ones mid-onboarding, who
 * have the least patience for it.
 *
 * So this answers the question first: which tenants would be refused, why, and
 * are they actually serving anyone right now.
 *
 * Read-only. It changes nothing and never calls the provider.
 */
import { prisma, getBalance, checkPaidAccess } from "@chatcenter/shared";

/** A conversation inside this window means the tenant is genuinely live. */
const ACTIVITY_WINDOW_DAYS = 7;

/**
 * Every reason the gate can give, in this module's vocabulary.
 *
 * `units_exhausted` is kept as the local spelling of the gate's
 * `credits_exhausted`, because it is what the Sysadmin surface and its readers
 * already say.
 */
export type BlockReason =
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
  | "feature_not_in_plan"
  | "units_exhausted";

export interface AffectedTenant {
  tenantId: string;
  name: string;
  status: string;
  reason: BlockReason;
  /** Conversations in the activity window. Zero means nobody notices today. */
  recentConversations: number;
  /** True when the tenant is actively serving customers and would go quiet. */
  live: boolean;
  subscriptionStatus: string | null;
  creditBalance: number | null;
}

export interface EnforcementPreview {
  mode: string;
  /** True when refusals are already in force, so this is a report not a forecast. */
  enforcing: boolean;
  affected: AffectedTenant[];
  totals: { tenants: number; live: number; byReason: Record<string, number> };
}

/**
 * Everyone the runtime would refuse.
 *
 * Asks the gate itself, once per tenant, under an assumed `enforce`. It used to
 * mirror the gate's ordering by hand, with a comment explaining that a preview
 * which disagrees with the gate is worse than no preview - and then the gate
 * grew stricter and the mirror did not follow it. The preview quietly began
 * understating who would be cut off, which is the exact way this report gets
 * someone into trouble: it is read once, believed, and acted on.
 *
 * Calling the real thing means it cannot drift again.
 *
 * Read-only. It changes nothing and never calls the provider.
 */
export async function previewEnforcement(now: Date = new Date()): Promise<EnforcementPreview> {
  const mode = (process.env.BILLING_ENFORCEMENT_MODE || "off").toLowerCase();
  const since = new Date(now.getTime() - ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const tenants = await prisma.tenant.findMany({
    where: { status: { in: ["PENDING_PAYMENT", "SUSPENDED", "ACTIVE"] } },
    select: { id: true, name: true, status: true },
  });

  const affected: AffectedTenant[] = [];

  for (const tenant of tenants) {
    // The one source of the answer. `assumeMode` makes it report what WOULD
    // happen under enforcement while enforcement is still off, which is the
    // whole point of a forecast.
    const decision = await checkPaidAccess({ tenantId: tenant.id, assumeMode: "enforce", now });
    if (!decision.wouldDeny) continue;

    const reason: BlockReason =
      decision.reason === "credits_exhausted" ? "units_exhausted" : (decision.reason as BlockReason);

    const link = await prisma.billableEntityTenant.findUnique({
      where: { tenantId: tenant.id },
      include: { entity: { include: { subscription: true } } },
    });

    const recentConversations = await prisma.conversation.count({
      where: { tenantId: tenant.id, createdAt: { gte: since } },
    });

    affected.push({
      tenantId: tenant.id,
      name: tenant.name,
      status: tenant.status,
      reason,
      recentConversations,
      // The number that decides whether this is a quiet config change or an
      // outage for someone's customers.
      live: recentConversations > 0,
      subscriptionStatus: link?.entity.subscription?.status ?? null,
      creditBalance: reason === "units_exhausted" ? (decision.balance ?? 0) : null,
    });
  }

  // Live tenants first: they are the ones a person needs to look at.
  affected.sort((a, b) => Number(b.live) - Number(a.live) || b.recentConversations - a.recentConversations);

  const byReason: Record<string, number> = {};
  for (const t of affected) byReason[t.reason] = (byReason[t.reason] ?? 0) + 1;

  return {
    mode,
    enforcing: mode === "hard" || mode === "enforce",
    affected,
    totals: { tenants: affected.length, live: affected.filter((t) => t.live).length, byReason },
  };
}

/**
 * Remaining credits, read through the SAME helper the runtime gate uses.
 *
 * Summing the lots here would be a second implementation of the wallet, and the
 * two would eventually disagree - at which point this preview would confidently
 * report the wrong thing, which is worse than not having it.
 */
async function creditBalance(tenantId: string): Promise<number> {
  try {
    return (await getBalance(tenantId)).total;
  } catch {
    // "Cannot tell", not "zero". Reporting a tenant as out of credits because a
    // query failed would send someone chasing a problem that does not exist.
    return Number.POSITIVE_INFINITY;
  }
}
