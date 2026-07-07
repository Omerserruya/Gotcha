/**
 * Subscription lifecycle.
 *
 *   Trial:    signup → TRIALING (card already tokenized) → first charge → ACTIVE
 *   Upgrade:  immediate, prorated, included Units topped up now
 *   Downgrade: DEFERRED via PendingSubscriptionChange (never mutate active sub)
 *   Cancel:   deferred to period end (resume clears it)
 *   Renew:    charge at period end → roll period + reset included Units
 *   Dunning:  charge fail → PAST_DUE → (handled by dunning.service) → SUSPENDED
 *
 * Entitlements are recomputed via materializeEntitlements() (plan defaults ⊕
 * overrides → TenantFeature). Included Units use rolloverIncluded() (expire old
 * period, grant new). Purchased Units are NEVER touched here.
 */
import { prisma, materializeEntitlements, rolloverIncluded, grantUnits, getBalance } from "@chatcenter/shared";
import type { Subscription, SubscriptionStatus } from "@prisma/client";
import { ensureBillableEntity, getEntityIdForTenant, tenantsForEntity } from "./billable-entity.service";
import { getPlan, isUpgrade } from "./plan.service";
import { currentPeriod, nextPeriod, periodKeyFor } from "../lib/period";
import { emitBillingEvent } from "../lib/events";
import { chargeFor } from "./invoice.service";
import { unsuspendTenants } from "./tenant-status.service";

const TRIAL_DAYS = parseInt(process.env.BILLING_TRIAL_DAYS || "14", 10);

async function recordEvent(
  subscriptionId: string,
  type: string,
  from: SubscriptionStatus | null,
  to: SubscriptionStatus | null,
  actor?: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await prisma.subscriptionEvent.create({ data: { subscriptionId, type, fromStatus: from, toStatus: to, actor: actor ?? "system", metadata: (metadata ?? {}) as any } });
}

/** Grant/refresh the INCLUDED allowance for every tenant funded by the entity. */
async function grantIncludedForEntity(entityId: string, allowance: number, periodKey: string, expiresAt: Date, source: string): Promise<void> {
  const tenants = await tenantsForEntity(entityId);
  for (const t of tenants) await rolloverIncluded(t, periodKey, allowance, expiresAt, source);
}

async function materializeForEntity(entityId: string, actor?: string): Promise<void> {
  const tenants = await tenantsForEntity(entityId);
  for (const t of tenants) await materializeEntitlements(t, actor);
}

// ── Trial ───────────────────────────────────────────────────────────────────

export async function createTrialSubscription(input: {
  tenantId: string;
  planKey: string;
  billingProfileId?: string;
  actor?: string;
}): Promise<Subscription> {
  const entityId = await ensureBillableEntity(input.tenantId);
  const plan = await getPlan(input.planKey);
  if (!plan) throw new Error(`unknown plan ${input.planKey}`);

  // Mandatory card-on-file (tokenized + J5-verified on the PayPage) BEFORE the
  // trial starts. No card → no trial; the entity exists but stays unprovisioned
  // until a payment method is added. Skipped if a subscription already exists
  // (idempotent re-provision / plan change after the card is on file).
  const existing = await prisma.subscription.findUnique({ where: { billableEntityId: entityId } });
  if (!existing) {
    const profile = await prisma.billingProfile.findUnique({
      where: { billableEntityId: entityId },
      include: { paymentMethods: { where: { status: "ACTIVE" }, take: 1 } },
    });
    if (!profile || profile.paymentMethods.length === 0) {
      throw new Error("payment_method_required");
    }
  }

  const now = new Date();
  const trialEndsAt = new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
  const periodKey = periodKeyFor(now);

  const sub = await prisma.subscription.upsert({
    where: { billableEntityId: entityId },
    create: {
      billableEntityId: entityId,
      billingProfileId: input.billingProfileId,
      planKey: plan.key,
      planVersion: plan.version,
      status: "TRIALING",
      enforcementEnabled: true,
      trialEndsAt,
      currentPeriodStart: now,
      currentPeriodEnd: trialEndsAt,
    },
    update: {
      billingProfileId: input.billingProfileId,
      planKey: plan.key,
      planVersion: plan.version,
      status: "TRIALING",
      enforcementEnabled: true,
      trialEndsAt,
      currentPeriodStart: now,
      currentPeriodEnd: trialEndsAt,
    },
  });

  await materializeForEntity(entityId, input.actor);
  await grantIncludedForEntity(entityId, plan.includedAiUnits, periodKey, trialEndsAt, `trial:${plan.key}`);
  await recordEvent(sub.id, "trial_started", null, "TRIALING", input.actor, { planKey: plan.key, trialEndsAt });
  await emitBillingEvent({ type: "subscription.trial_started", tenantId: input.tenantId, data: { planKey: plan.key, trialEndsAt } });
  return sub;
}

// ── Activation / renewal (charge then roll period) ───────────────────────────

/** Charge the plan price and, on success, activate + reset included Units. */
export async function activateOrRenew(subscriptionId: string, opts: { reason: "trial_end" | "renewal" } = { reason: "renewal" }): Promise<{ success: boolean }> {
  const sub = await prisma.subscription.findUnique({ where: { id: subscriptionId } });
  if (!sub) return { success: false };
  const plan = await getPlan(sub.planKey, sub.planVersion);
  if (!plan) return { success: false };
  const tenantId = (await tenantsForEntity(sub.billableEntityId))[0];

  const periodStart = new Date();
  const period = currentPeriod(periodStart);

  // Sales-only / grandfathered plans (no public price) skip charging.
  const price = plan.basePrice ? Number(plan.basePrice) : 0;
  if (price > 0) {
    const res = await chargeFor({
      entityId: sub.billableEntityId,
      tenantId,
      type: "SUBSCRIPTION",
      amount: price,
      currency: plan.currency,
      description: `${plan.name} subscription (${period.key})`,
      idempotencyKey: `sub:${subscriptionId}:${period.key}`,
    });
    if (!res.success) {
      await prisma.subscription.update({ where: { id: subscriptionId }, data: { status: "PAST_DUE" } });
      await recordEvent(subscriptionId, "renewal_failed", sub.status, "PAST_DUE", "scheduler", { invoiceId: res.invoiceId });
      await emitBillingEvent({ type: "subscription.past_due", tenantId, data: { reason: res.failureCode } });
      return { success: false };
    }
  }

  await prisma.subscription.update({
    where: { id: subscriptionId },
    data: { status: "ACTIVE", currentPeriodStart: period.start, currentPeriodEnd: period.end, trialEndsAt: null },
  });
  await unsuspendTenants(sub.billableEntityId);
  // Roll the period: EXPIRE the prior period's INCLUDED remainder (use-it-or-
  // lose-it, with an explicit EXPIRE ledger entry for auditability) and grant
  // the new period's allowance. Purchased Units are untouched.
  await rolloverIncluded(tenantId, period.key, plan.includedAiUnits, period.end, `plan:${plan.key}`);
  await recordEvent(subscriptionId, opts.reason === "trial_end" ? "activated" : "renewed", sub.status, "ACTIVE", "scheduler");
  await emitBillingEvent({ type: "subscription.activated", tenantId, data: { planKey: plan.key, periodEnd: period.end } });
  return { success: true };
}

// ── Plan change ──────────────────────────────────────────────────────────────

export async function changePlan(input: { tenantId: string; targetPlanKey: string; actor?: string }): Promise<{ applied: "immediate" | "scheduled" }> {
  const entityId = await getEntityIdForTenant(input.tenantId);
  if (!entityId) throw new Error("no billable entity");
  const sub = await prisma.subscription.findUnique({ where: { billableEntityId: entityId } });
  if (!sub) throw new Error("no subscription");
  const target = await getPlan(input.targetPlanKey);
  if (!target) throw new Error(`unknown plan ${input.targetPlanKey}`);

  if (isUpgrade(sub.planKey, target.key)) {
    // Immediate, prorated. Top up included Units to the new allowance for the
    // current period; recompute entitlements now.
    const periodKey = sub.currentPeriodStart ? periodKeyFor(sub.currentPeriodStart) : periodKeyFor(new Date());
    const periodEnd = sub.currentPeriodEnd ?? new Date();
    const tenantId = input.tenantId;

    // Charge the prorated difference FIRST. We must NOT grant the new plan's
    // features/units on a failed charge — otherwise an upgrade with a declined
    // (or missing) card silently hands out paid entitlements. A TRIALING
    // subscription has no money due yet, so it upgrades without an immediate
    // charge (the higher price lands at trial-end activation).
    const fromPlan = await getPlan(sub.planKey, sub.planVersion);
    const proration = Math.max(0, (target.basePrice ? Number(target.basePrice) : 0) - (fromPlan?.basePrice ? Number(fromPlan.basePrice) : 0));
    const chargeDue = proration > 0 && sub.status !== "TRIALING";
    if (chargeDue) {
      // Scope the idempotency key to the payment method that will be charged.
      // A failed attempt (e.g. no/declined card) must not permanently block a
      // retry after the customer adds a valid card; a double-click on the SAME
      // card stays idempotent because the key is identical.
      const billingProfile = await prisma.billingProfile.findUnique({ where: { billableEntityId: entityId }, include: { paymentMethods: { where: { status: "ACTIVE" }, orderBy: { isDefault: "desc" }, take: 1 } } });
      const pmKey = billingProfile?.paymentMethods[0]?.id ?? "nocard";
      const res = await chargeFor({ entityId, tenantId, type: "SUBSCRIPTION", amount: proration, currency: target.currency, description: `Upgrade to ${target.name} (prorated)`, idempotencyKey: `upgrade:${sub.id}:${periodKey}:${target.key}:${pmKey}` });
      if (!res.success) {
        await emitBillingEvent({ type: "payment.failed", tenantId, data: { invoiceId: res.invoiceId, reason: res.failureCode, context: "upgrade", targetPlan: target.key } });
        throw new Error(`upgrade_payment_failed:${res.failureCode ?? "charge_failed"}`);
      }
    }

    // Payment settled (or nothing due) → now it's safe to flip the plan,
    // recompute entitlements, and top up included Units.
    await prisma.subscription.update({ where: { id: sub.id }, data: { planKey: target.key, planVersion: target.version } });
    await materializeForEntity(entityId, input.actor);
    const bal = await getBalance(tenantId);
    const delta = Math.max(0, target.includedAiUnits - bal.includedAllowance);
    if (delta > 0) {
      await grantUnits({ tenantId, bucket: "INCLUDED", grantType: "PLAN", units: delta, periodKey, expiresAt: periodEnd, source: `upgrade:${target.key}`, includedAllowance: target.includedAiUnits });
    }
    await recordEvent(sub.id, "plan_changed", sub.status, sub.status, input.actor, { from: sub.planKey, to: target.key, kind: "upgrade" });
    await emitBillingEvent({ type: "subscription.plan_changed", tenantId, data: { from: sub.planKey, to: target.key, when: "immediate" } });
    return { applied: "immediate" };
  }

  // Downgrade → deferred to period end via a pending change.
  await prisma.pendingSubscriptionChange.upsert({
    where: { subscriptionId: sub.id },
    create: { subscriptionId: sub.id, changeType: "DOWNGRADE", targetPlanKey: target.key, targetPlanVersion: target.version, effectiveAt: sub.currentPeriodEnd ?? new Date(), createdBy: input.actor },
    update: { changeType: "DOWNGRADE", targetPlanKey: target.key, targetPlanVersion: target.version, effectiveAt: sub.currentPeriodEnd ?? new Date(), createdBy: input.actor, appliedAt: null },
  });
  await recordEvent(sub.id, "downgrade_scheduled", sub.status, sub.status, input.actor, { to: target.key, effectiveAt: sub.currentPeriodEnd });
  await emitBillingEvent({ type: "subscription.plan_changed", tenantId: input.tenantId, data: { from: sub.planKey, to: target.key, when: "period_end", effectiveAt: sub.currentPeriodEnd } });
  return { applied: "scheduled" };
}

// ── Cancel / resume (deferred to period end) ─────────────────────────────────

export async function cancelSubscription(input: { tenantId: string; actor?: string }): Promise<void> {
  const entityId = await getEntityIdForTenant(input.tenantId);
  if (!entityId) throw new Error("no billable entity");
  const sub = await prisma.subscription.findUnique({ where: { billableEntityId: entityId } });
  if (!sub) throw new Error("no subscription");
  await prisma.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: true } });
  await prisma.pendingSubscriptionChange.upsert({
    where: { subscriptionId: sub.id },
    create: { subscriptionId: sub.id, changeType: "CANCEL", effectiveAt: sub.currentPeriodEnd ?? new Date(), createdBy: input.actor },
    update: { changeType: "CANCEL", targetPlanKey: null, effectiveAt: sub.currentPeriodEnd ?? new Date(), createdBy: input.actor, appliedAt: null },
  });
  await recordEvent(sub.id, "cancel_scheduled", sub.status, sub.status, input.actor, { effectiveAt: sub.currentPeriodEnd });
  await emitBillingEvent({ type: "subscription.canceled", tenantId: input.tenantId, data: { when: "period_end", effectiveAt: sub.currentPeriodEnd } });
}

export async function resumeSubscription(input: { tenantId: string; actor?: string }): Promise<void> {
  const entityId = await getEntityIdForTenant(input.tenantId);
  if (!entityId) throw new Error("no billable entity");
  const sub = await prisma.subscription.findUnique({ where: { billableEntityId: entityId } });
  if (!sub) throw new Error("no subscription");
  await prisma.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: false } });
  await prisma.pendingSubscriptionChange.deleteMany({ where: { subscriptionId: sub.id, changeType: "CANCEL", appliedAt: null } });
  await recordEvent(sub.id, "resumed", sub.status, sub.status, input.actor);
  await emitBillingEvent({ type: "subscription.resumed", tenantId: input.tenantId, data: {} });
}

// ── Scheduler entrypoints ────────────────────────────────────────────────────

/** Apply downgrades/cancels whose effectiveAt has passed. */
export async function applyDuePendingChanges(now = new Date()): Promise<number> {
  const due = await prisma.pendingSubscriptionChange.findMany({ where: { appliedAt: null, effectiveAt: { lte: now } }, include: { subscription: true } });
  let applied = 0;
  for (const change of due) {
    const sub = change.subscription;
    const tenantId = (await tenantsForEntity(sub.billableEntityId))[0];
    if (change.changeType === "CANCEL") {
      await prisma.subscription.update({ where: { id: sub.id }, data: { status: "CANCELED" } });
      await recordEvent(sub.id, "canceled", sub.status, "CANCELED", "scheduler");
    } else if (change.changeType === "DOWNGRADE" && change.targetPlanKey) {
      const target = await getPlan(change.targetPlanKey, change.targetPlanVersion ?? 1);
      if (target) {
        const period = currentPeriod(sub.currentPeriodEnd ?? now);
        await prisma.subscription.update({ where: { id: sub.id }, data: { planKey: target.key, planVersion: target.version, currentPeriodStart: period.start, currentPeriodEnd: period.end } });
        await materializeForEntity(sub.billableEntityId, "scheduler");
        await grantIncludedForEntity(sub.billableEntityId, target.includedAiUnits, period.key, period.end, `downgrade:${target.key}`);
        await recordEvent(sub.id, "downgrade_applied", sub.status, sub.status, "scheduler", { to: target.key });
      }
    }
    await prisma.pendingSubscriptionChange.update({ where: { id: change.id }, data: { appliedAt: now } });
    applied++;
  }
  return applied;
}

/** Charge trials whose window ended; renew active subs whose period ended. */
export async function runBillingCycle(now = new Date()): Promise<{ trials: number; renewals: number; pending: number }> {
  const pending = await applyDuePendingChanges(now);

  const trials = await prisma.subscription.findMany({ where: { status: "TRIALING", trialEndsAt: { lte: now } } });
  for (const s of trials) await activateOrRenew(s.id, { reason: "trial_end" });

  const renewals = await prisma.subscription.findMany({ where: { status: "ACTIVE", cancelAtPeriodEnd: false, currentPeriodEnd: { lte: now } } });
  for (const s of renewals) await activateOrRenew(s.id, { reason: "renewal" });

  return { trials: trials.length, renewals: renewals.length, pending };
}
