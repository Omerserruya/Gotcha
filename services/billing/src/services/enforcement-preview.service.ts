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
import { prisma, getBalance } from "@chatcenter/shared";

/** A conversation inside this window means the tenant is genuinely live. */
const ACTIVITY_WINDOW_DAYS = 7;

export type BlockReason =
  | "payment_required"
  | "tenant_suspended"
  | "subscription_suspended"
  | "subscription_canceled"
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
 * Deliberately mirrors `checkAiAllowed`'s ordering rather than re-deriving it:
 * tenant state first, then subscription, then balance. A preview that disagrees
 * with the gate is worse than no preview, because it will be trusted.
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
    const link = await prisma.billableEntityTenant.findUnique({
      where: { tenantId: tenant.id },
      include: { entity: { include: { subscription: true } } },
    });
    const sub = link?.entity.subscription ?? null;

    let reason: BlockReason | null = null;

    // Tenant state first, exactly as the gate evaluates it.
    if (tenant.status === "PENDING_PAYMENT") reason = "payment_required";
    else if (tenant.status === "SUSPENDED") reason = "tenant_suspended";
    else if (sub && sub.enforcementEnabled) {
      if (sub.status === "SUSPENDED") reason = "subscription_suspended";
      else if (sub.status === "CANCELED") reason = "subscription_canceled";
      else {
        const balance = await creditBalance(tenant.id);
        if (balance <= 0) reason = "units_exhausted";
      }
    }

    if (!reason) continue;

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
      subscriptionStatus: sub?.status ?? null,
      creditBalance: reason === "units_exhausted" ? 0 : null,
    });
  }

  // Live tenants first: they are the ones a person needs to look at.
  affected.sort((a, b) => Number(b.live) - Number(a.live) || b.recentConversations - a.recentConversations);

  const byReason: Record<string, number> = {};
  for (const t of affected) byReason[t.reason] = (byReason[t.reason] ?? 0) + 1;

  return {
    mode,
    enforcing: mode === "hard",
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
