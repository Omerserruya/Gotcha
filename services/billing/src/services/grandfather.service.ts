/**
 * Grandfathered compatibility state — temporary, one-way.
 *
 *   • Backfill: every existing tenant gets a BillableEntity + a GRANDFATHERED
 *     subscription with enforcementEnabled=false (AI gate skipped, billing off,
 *     full features). NOT "unlimited Units" — there is simply no enforcement,
 *     so financial state stays deterministic.
 *   • Migration: an explicit one-way move to a real paid plan. Once migrated a
 *     tenant can NEVER return to GRANDFATHERED.
 */
import { prisma, materializeEntitlements } from "@chatcenter/shared";
import { ensureBillableEntity, getEntityIdForTenant } from "./billable-entity.service";
import { createTrialSubscription } from "./subscription.service";
import { getPlan } from "./plan.service";

/** Put one tenant into the grandfathered state. Idempotent. */
export async function grandfatherTenant(tenantId: string): Promise<void> {
  const entityId = await ensureBillableEntity(tenantId);
  const existing = await prisma.subscription.findUnique({ where: { billableEntityId: entityId } });
  // Never regress a real subscription back to grandfathered.
  if (existing && existing.planKey !== "grandfathered") return;

  await prisma.billingProfile.upsert({
    where: { billableEntityId: entityId },
    create: { billableEntityId: entityId, provider: "MANUAL", status: "ACTIVE" },
    update: {},
  });
  await prisma.subscription.upsert({
    where: { billableEntityId: entityId },
    create: { billableEntityId: entityId, planKey: "grandfathered", planVersion: 1, status: "GRANDFATHERED", enforcementEnabled: false },
    update: { planKey: "grandfathered", status: "GRANDFATHERED", enforcementEnabled: false },
  });
  await materializeEntitlements(tenantId, "grandfather");
}

/** Backfill ALL tenants. Safe to re-run. */
export async function backfillAllTenants(): Promise<{ count: number }> {
  const tenants = await prisma.tenant.findMany({ select: { id: true } });
  for (const t of tenants) await grandfatherTenant(t.id);
  return { count: tenants.length };
}

/** One-way migration from GRANDFATHERED to a real paid plan (starts a trial). */
export async function migrateFromGrandfathered(input: { tenantId: string; planKey: string; billingProfileId?: string; actor?: string }): Promise<void> {
  const entityId = await getEntityIdForTenant(input.tenantId);
  if (!entityId) throw new Error("no billable entity");
  const sub = await prisma.subscription.findUnique({ where: { billableEntityId: entityId } });
  if (!sub) throw new Error("no subscription");
  if (sub.planKey !== "grandfathered") throw new Error("tenant is not grandfathered (migration is one-way)");
  const target = await getPlan(input.planKey);
  if (!target || target.key === "grandfathered") throw new Error(`invalid target plan ${input.planKey}`);

  // Enable enforcement and start a normal trial on the chosen plan.
  await prisma.subscription.update({ where: { id: sub.id }, data: { enforcementEnabled: true } });
  await createTrialSubscription({ tenantId: input.tenantId, planKey: target.key, billingProfileId: input.billingProfileId, actor: input.actor });
}
