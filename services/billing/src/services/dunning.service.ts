/**
 * Dunning — retry failed renewals on a ladder, then suspend.
 *
 *   PAST_DUE → retry on days 0/3/7 (configurable) → SUSPENDED.
 *
 * Suspension flips Subscription.status=SUSPENDED. The AI runtime gate refuses
 * AI when the subscription isn't serviceable; the rest of the platform keeps
 * working. Tenant.status is driven from subscription state by Phase 4, NOT here
 * (a future multi-tenant account fans one subscription to many tenants).
 */
import { prisma } from "@chatcenter/shared";
import { tenantsForEntity } from "./billable-entity.service";
import { getPlan } from "./plan.service";
import { chargeFor } from "./invoice.service";
import { emitBillingEvent } from "../lib/events";
import { periodKeyFor } from "../lib/period";
import { suspendTenants, unsuspendTenants } from "./tenant-status.service";

const RETRY_DAYS = (process.env.BILLING_DUNNING_DAYS || "0,3,7").split(",").map((n) => parseInt(n.trim(), 10));
const MAX_ATTEMPTS = RETRY_DAYS.length;

function nextRetryAt(stage: number): Date | null {
  if (stage >= RETRY_DAYS.length) return null;
  return new Date(Date.now() + RETRY_DAYS[stage] * 24 * 60 * 60 * 1000);
}

/** Ensure a PAST_DUE subscription has a dunning record scheduling its first retry. */
export async function openDunning(subscriptionId: string): Promise<void> {
  await prisma.dunningState.upsert({
    where: { subscriptionId },
    create: { subscriptionId, stage: 0, attempts: 0, nextRetryAt: nextRetryAt(0) },
    update: {},
  });
}

/** Process due dunning retries; charge again or suspend after the ladder. */
export async function runDunning(now = new Date()): Promise<{ retried: number; suspended: number }> {
  // Make sure every PAST_DUE sub has an open dunning record.
  const pastDue = await prisma.subscription.findMany({ where: { status: "PAST_DUE", dunning: { is: null } } });
  for (const s of pastDue) await openDunning(s.id);

  const due = await prisma.dunningState.findMany({ where: { nextRetryAt: { lte: now } }, include: { subscription: true } });
  let retried = 0;
  let suspended = 0;

  for (const d of due) {
    const sub = d.subscription;
    if (sub.status !== "PAST_DUE") {
      await prisma.dunningState.delete({ where: { id: d.id } }).catch(() => {});
      continue;
    }
    const tenantId = (await tenantsForEntity(sub.billableEntityId))[0];
    const plan = await getPlan(sub.planKey, sub.planVersion);
    const price = plan?.basePrice ? Number(plan.basePrice) : 0;
    const periodKey = sub.currentPeriodEnd ? periodKeyFor(sub.currentPeriodEnd) : periodKeyFor(now);

    const res = price > 0
      ? await chargeFor({ entityId: sub.billableEntityId, tenantId, type: "SUBSCRIPTION", amount: price, currency: plan!.currency, description: `${plan!.name} renewal retry`, idempotencyKey: `dunning:${sub.id}:${periodKey}:${d.attempts + 1}`, attemptNumber: d.attempts + 1 })
      : { success: true, invoiceId: "" };

    if (res.success) {
      await prisma.subscription.update({ where: { id: sub.id }, data: { status: "ACTIVE" } });
      await prisma.dunningState.delete({ where: { id: d.id } });
      await unsuspendTenants(sub.billableEntityId);
      await prisma.subscriptionEvent.create({ data: { subscriptionId: sub.id, type: "dunning_recovered", fromStatus: "PAST_DUE", toStatus: "ACTIVE", actor: "scheduler" } });
      await emitBillingEvent({ type: "subscription.activated", tenantId, data: { recovered: true } });
      retried++;
      continue;
    }

    const stage = d.stage + 1;
    if (stage >= MAX_ATTEMPTS) {
      await prisma.subscription.update({ where: { id: sub.id }, data: { status: "SUSPENDED" } });
      await suspendTenants(sub.billableEntityId);
      await prisma.dunningState.update({ where: { id: d.id }, data: { stage, attempts: d.attempts + 1, nextRetryAt: null, lastFailureCode: res.failureCode } });
      await prisma.subscriptionEvent.create({ data: { subscriptionId: sub.id, type: "suspended", fromStatus: "PAST_DUE", toStatus: "SUSPENDED", actor: "scheduler", metadata: { reason: res.failureCode } as any } });
      await emitBillingEvent({ type: "subscription.suspended", tenantId, data: { reason: res.failureCode } });
      suspended++;
    } else {
      await prisma.dunningState.update({ where: { id: d.id }, data: { stage, attempts: d.attempts + 1, nextRetryAt: nextRetryAt(stage), lastFailureCode: res.failureCode } });
      await emitBillingEvent({ type: "payment.failed", tenantId, data: { stage, nextRetryAt: nextRetryAt(stage), reason: res.failureCode } });
      retried++;
    }
  }
  return { retried, suspended };
}
