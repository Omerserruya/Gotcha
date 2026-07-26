/**
 * Plan catalog helpers + tier ordering (for upgrade vs downgrade detection).
 *
 * Tier rank comes from `Plan.sortOrder`, which the Sysadmin console owns. The
 * previous hardcoded `["light","pro","business","enterprise"]` list meant any
 * plan key introduced without a code change ranked -1 and was treated as
 * NEITHER an upgrade nor a downgrade - so a move to it silently took the
 * deferred downgrade path. Ranking from data removes that class of bug.
 */
import { prisma } from "@chatcenter/shared";

/** Rank a plan for upgrade/downgrade comparison. Higher = higher tier. */
export async function tierRank(key: string, version?: number): Promise<number> {
  const plan = await prisma.plan.findFirst({
    where: { key, ...(version ? { version } : {}) },
    orderBy: { version: "desc" },
    select: { sortOrder: true, basePrice: true },
  });
  if (!plan) return -1;
  // sortOrder is authoritative; price breaks ties so two plans that were never
  // explicitly ordered still compare sensibly rather than arbitrarily.
  return plan.sortOrder * 1_000_000 + Number(plan.basePrice ?? 0);
}

/** true if moving `from` -> `to` is an upgrade (higher tier). */
export async function isUpgrade(
  from: string,
  to: string,
  fromVersion?: number,
  toVersion?: number,
): Promise<boolean> {
  const [a, b] = await Promise.all([tierRank(from, fromVersion), tierRank(to, toVersion)]);
  return a >= 0 && b >= 0 && b > a;
}

export async function getPlan(key: string, version = 1) {
  return prisma.plan.findUnique({ where: { key_version: { key, version } } });
}

/**
 * The ACTIVE version of a plan key - what a NEW subscriber receives. Existing
 * subscriptions stay pinned to their own version until explicitly migrated.
 */
export async function getActivePlanVersion(key: string) {
  return prisma.plan.findFirst({ where: { key, status: "ACTIVE" }, orderBy: { version: "desc" } });
}

/**
 * Catalog listing for the `/billing/plans` contract.
 *
 * Includes RETIRED plans so a customer still on one keeps seeing their own
 * plan's name and price rather than a blank card, and so the migration path off
 * it stays visible.
 */
export async function listActivePlans(tenantId?: string | null) {
  return prisma.plan.findMany({
    where: {
      active: true,
      status: { in: ["ACTIVE", "RETIRED"] },
      OR: [{ tenantId: null }, ...(tenantId ? [{ tenantId }] : [])],
    },
    include: { entitlements: true, volumeOptions: { orderBy: { sortOrder: "asc" } } },
    orderBy: [{ sortOrder: "asc" }, { basePrice: "asc" }],
  });
}

/** Plans a NEW subscriber may choose: ACTIVE only, plus this org's custom plan. */
export async function listSelectablePlans(tenantId?: string | null) {
  const now = new Date();
  return prisma.plan.findMany({
    where: {
      status: "ACTIVE",
      OR: [
        { kind: "PUBLIC", tenantId: null },
        ...(tenantId ? [{ kind: "CUSTOM" as const, tenantId }] : []),
      ],
      AND: [
        { OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: now } }] },
        { OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] },
      ],
    },
    include: { entitlements: true, volumeOptions: { orderBy: { sortOrder: "asc" } } },
    orderBy: { sortOrder: "asc" },
  });
}

/**
 * May this organization select this plan right now?
 *
 * Guards three things the frontend cannot be trusted with: a DRAFT or RETIRED
 * version is never selectable, a CUSTOM plan belongs to exactly one
 * organization, and POC/TRIAL plans are operator-provisioned only.
 */
export async function assertSelectable(planKey: string, tenantId: string): Promise<void> {
  const plan = await getActivePlanVersion(planKey);
  if (!plan) throw new Error(`unknown_plan:${planKey}`);
  if (plan.kind === "CUSTOM" && plan.tenantId !== tenantId) throw new Error("plan_not_available");
  if (plan.kind === "POC" || plan.kind === "TRIAL") throw new Error("plan_requires_operator");
}
