/**
 * POC / pilot tenants - "free trial without a card".
 *
 * A POC is a REAL subscription (so the AI-Units gate enforces it - never the
 * fail-open no-subscription bypass) on a dedicated sales-only `poc` plan:
 *
 *   • no card, no charges, no dunning - `cancelAtPeriodEnd=true` keeps it out
 *     of the renewal sweep, and the plan has no price to charge;
 *   • the operator sets the credit budget: granted as the INCLUDED allowance
 *     via rolloverIncluded(), so the 80/90/95/100% usage-threshold alerts and
 *     the hard-block at zero work exactly like a paying tenant;
 *   • optional expiry = currentPeriodEnd; expireDuePocs() (run by the billing
 *     cycle) cancels it - CANCELED is refused by the AI gate in hard mode -
 *     and reverts the POC's expired TRIAL feature entitlements so the UI
 *     locks down too.
 *
 * Feature selection is written by the caller (the auth system console) as
 * TRIAL-source TenantEntitlements sharing the same expiry.
 */
import { prisma, rolloverIncluded, getBalance, invalidatePermissionsCache, type BalanceView } from "@chatcenter/shared";
import { ensureBillableEntity, tenantsForEntity } from "./billable-entity.service";
import { periodKeyFor } from "../lib/period";
import { emitBillingEvent } from "../lib/events";

export const POC_PLAN_KEY = "poc";
const FAR_FUTURE_DAYS = 3650; // "no expiry" - far enough to be effectively unlimited

async function ensurePocPlan(): Promise<void> {
  await prisma.plan.upsert({
    where: { key_version: { key: POC_PLAN_KEY, version: 1 } },
    update: {},
    create: { key: POC_PLAN_KEY, version: 1, name: "POC / Pilot", basePrice: null, includedAiUnits: 0, salesOnly: true },
  });
}

export async function setupPoc(input: {
  tenantId: string;
  credits: number;
  expiresAt?: Date | null;
  actor?: string;
}): Promise<{ subscriptionId: string; balance: BalanceView; expiresAt: Date | null }> {
  const { tenantId } = input;
  const credits = Math.max(0, input.credits);
  const entityId = await ensureBillableEntity(tenantId);
  await ensurePocPlan();

  const now = new Date();
  const periodEnd = input.expiresAt ?? new Date(now.getTime() + FAR_FUTURE_DAYS * 86_400_000);

  const sub = await prisma.subscription.upsert({
    where: { billableEntityId: entityId },
    create: {
      billableEntityId: entityId,
      planKey: POC_PLAN_KEY,
      planVersion: 1,
      status: "ACTIVE",
      enforcementEnabled: true, // the whole point: the credits gate BITES
      cancelAtPeriodEnd: true, // keeps the renewal sweep away - no charges, ever
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      trialEndsAt: null,
    },
    update: {
      planKey: POC_PLAN_KEY,
      planVersion: 1,
      status: "ACTIVE",
      enforcementEnabled: true,
      cancelAtPeriodEnd: true,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      trialEndsAt: null,
    },
  });

  // The budget: INCLUDED allowance = the operator-set credits, so consumption %
  // (and the 80/100 alerts) are computed against exactly that budget. Any
  // previous POC allowance is expired by the rollover, not stacked.
  await rolloverIncluded(tenantId, periodKeyFor(now), credits, periodEnd, `poc:${input.actor ?? "system"}`);

  await emitBillingEvent({
    type: "subscription.activated",
    tenantId,
    data: { planKey: POC_PLAN_KEY, poc: true, credits, expiresAt: input.expiresAt?.toISOString() ?? null },
  });

  return { subscriptionId: sub.id, balance: await getBalance(tenantId), expiresAt: input.expiresAt ?? null };
}

/**
 * Cancel POCs whose window closed and revert their expired TRIAL feature rows.
 * Expired TRIAL entitlements silently drop out of getEffectiveEntitlements(),
 * but their materialized TenantFeature rows would keep the last value forever -
 * flip those OFF explicitly so the workspace UI locks down with the POC.
 */
export async function expireDuePocs(now = new Date()): Promise<number> {
  const due = await prisma.subscription.findMany({
    where: { planKey: POC_PLAN_KEY, status: "ACTIVE", currentPeriodEnd: { lte: now } },
    select: { id: true, billableEntityId: true },
  });
  for (const sub of due) {
    await prisma.subscription.update({ where: { id: sub.id }, data: { status: "CANCELED" } });
    for (const tenantId of await tenantsForEntity(sub.billableEntityId)) {
      const expired = await prisma.tenantEntitlement.findMany({
        where: { tenantId, source: "TRIAL", valueType: "BOOLEAN", expiresAt: { lte: now } },
        select: { entitlementKey: true },
      });
      for (const e of expired) {
        await prisma.tenantFeature.updateMany({ where: { tenantId, feature: e.entitlementKey }, data: { enabled: false } });
      }
      if (expired.length) invalidatePermissionsCache({ tenantId });
      await emitBillingEvent({ type: "subscription.canceled", tenantId, data: { planKey: POC_PLAN_KEY, poc: true, reason: "poc_expired" } });
    }
  }
  return due.length;
}
