/**
 * Subscription lifecycle.
 *
 *   Trial:     signup → TRIALING (card already tokenized) → first charge → ACTIVE
 *   Upgrade:   immediate, prorated, included credits topped up now
 *   Downgrade: DEFERRED via PendingSubscriptionChange (never mutate active sub)
 *   Volume:    a selector change on the same plan - up is immediate, down defers
 *   Cancel:    deferred to period end (resume clears it)
 *   Renew:     charge at period end → roll period + reset included credits
 *   Dunning:   charge fail → PAST_DUE → (handled by dunning.service) → SUSPENDED
 *
 * Commercial snapshot
 * -------------------
 * Renewal charges the SNAPSHOT price and grants the SNAPSHOT credit allowance,
 * not whatever the live Plan row currently says. That is what makes plan
 * versioning real: publishing a new version of `ai_workforce` changes what new
 * subscribers pay and leaves every existing subscription on the terms it agreed
 * to, until it is explicitly migrated. Subscriptions predating the snapshot
 * columns fall back to the live plan, so nothing breaks mid-migration.
 *
 * Entitlements are recomputed via materializeEntitlements() (plan defaults ⊕
 * overrides → TenantFeature). Included credits use rolloverIncluded() (expire
 * the old period, grant the new). Purchased credits are NEVER touched here.
 */
import { prisma, materializeEntitlements, rolloverIncluded, grantUnits, getBalance, expireDueLots, refreshUsdIlsRate } from "@chatcenter/shared";
import type { Subscription, SubscriptionStatus } from "@prisma/client";
import { ensureBillableEntity, getEntityIdForTenant, tenantsForEntity } from "./billable-entity.service";
import { getPlan, getActivePlanVersion, isUpgrade, assertSelectable } from "./plan.service";
import { quote, snapshotFor } from "./pricing.service";
import { currentPeriod, nextPeriod, periodKeyFor } from "../lib/period";
import { emitBillingEvent } from "../lib/events";
import { chargeFor } from "./invoice.service";
import { unsuspendTenants } from "./tenant-status.service";
import { expireDuePocs } from "./poc.service";

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

/**
 * The recurring price this subscription is actually on.
 *
 * The snapshot wins. A subscription created before the snapshot columns existed
 * has none, and falls back to its pinned plan version's price - which is still
 * its own version, not the newest one.
 */
export function contractedPrice(sub: { snapshotPrice: unknown }, plan: { basePrice: unknown } | null): number {
  if (sub.snapshotPrice != null) return Number(sub.snapshotPrice);
  return plan?.basePrice != null ? Number(plan.basePrice) : 0;
}

/** The recurring credit allowance this subscription is actually on. */
function contractedCredits(sub: { snapshotIncludedCredits: number | null }, plan: { includedAiUnits: number } | null): number {
  if (sub.snapshotIncludedCredits != null) return sub.snapshotIncludedCredits;
  return plan?.includedAiUnits ?? 0;
}

/** The default volume option keys for a plan, used when the customer picks none. */
async function defaultVolumeKeys(planId: string, plan: { chatVolumeEnabled: boolean; voiceVolumeEnabled: boolean }) {
  const options = await prisma.planVolumeOption.findMany({ where: { planId, isDefault: true, enabled: true } });
  return {
    chatVolumeOptionKey: plan.chatVolumeEnabled ? options.find((o) => o.channel === "CHAT")?.key ?? null : null,
    voiceVolumeOptionKey: plan.voiceVolumeEnabled ? options.find((o) => o.channel === "VOICE")?.key ?? null : null,
  };
}

// ── Trial ───────────────────────────────────────────────────────────────────

export async function createTrialSubscription(input: {
  tenantId: string;
  planKey: string;
  billingProfileId?: string;
  chatVolumeOptionKey?: string | null;
  voiceVolumeOptionKey?: string | null;
  actor?: string;
}): Promise<Subscription> {
  const entityId = await ensureBillableEntity(input.tenantId);
  // New subscribers always land on the plan key's ACTIVE version. Falling back
  // to version 1 would silently sign someone up to a retired revision.
  const plan = (await getActivePlanVersion(input.planKey)) ?? (await getPlan(input.planKey));
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

  // Default the volume selectors the plan actually offers, then price the whole
  // selection SERVER-SIDE and freeze it as the commercial snapshot.
  const defaults = await defaultVolumeKeys(plan.id, plan);
  const q = await quote({
    planKey: plan.key,
    planVersion: plan.version,
    chatVolumeOptionKey: input.chatVolumeOptionKey ?? defaults.chatVolumeOptionKey,
    voiceVolumeOptionKey: input.voiceVolumeOptionKey ?? defaults.voiceVolumeOptionKey,
    tenantId: input.tenantId,
  });
  const snapshot = snapshotFor(q);

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
      billingInterval: plan.billingInterval,
      ...snapshot,
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
      billingInterval: plan.billingInterval,
      ...snapshot,
    },
  });

  await materializeForEntity(entityId, input.actor);
  await grantIncludedForEntity(entityId, q.includedCredits, periodKey, trialEndsAt, `trial:${plan.key}`);
  await recordEvent(sub.id, "trial_started", null, "TRIALING", input.actor, { planKey: plan.key, planVersion: plan.version, trialEndsAt });
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

  // Charge the CONTRACTED price - the snapshot the customer agreed to, not
  // whatever the live plan row says today. Sales-only / grandfathered plans
  // (no price) skip charging entirely.
  const price = contractedPrice(sub, plan);
  const currency = sub.snapshotCurrency ?? plan.currency;
  if (price > 0) {
    const res = await chargeFor({
      entityId: sub.billableEntityId,
      tenantId,
      type: "SUBSCRIPTION",
      amount: price,
      currency,
      description: `${plan.name} subscription (${period.key})`,
      idempotencyKey: `sub:${subscriptionId}:${period.key}`,
    });
    if (res.outcomeUnknown) {
      // We do not know whether the customer was charged. PAST_DUE would put
      // them into the dunning ladder, and dunning retries - which would take
      // the money a second time if the first charge actually landed. The
      // subscription is left where it is, and a human reconciles.
      await recordEvent(subscriptionId, "renewal_outcome_unknown", sub.status, sub.status, "scheduler", {
        invoiceId: res.invoiceId,
        reason: res.failureCode,
      });
      await emitBillingEvent({
        type: "subscription.renewal_unknown",
        tenantId,
        data: { invoiceId: res.invoiceId, reason: res.failureCode },
      });
      return { success: false };
    }
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
  // the new period's allowance. Purchased credits are untouched, because they
  // are the customer's property and do not reset with the billing period.
  await rolloverIncluded(tenantId, period.key, contractedCredits(sub, plan), period.end, `plan:${plan.key}`);
  await recordEvent(subscriptionId, opts.reason === "trial_end" ? "activated" : "renewed", sub.status, "ACTIVE", "scheduler");
  await emitBillingEvent({ type: "subscription.activated", tenantId, data: { planKey: plan.key, periodEnd: period.end } });
  return { success: true };
}

// ── Plan change ──────────────────────────────────────────────────────────────

export interface ChangePlanInput {
  tenantId: string;
  targetPlanKey: string;
  /** Volume selector keys. Prices and credits are NEVER accepted from a client. */
  chatVolumeOptionKey?: string | null;
  voiceVolumeOptionKey?: string | null;
  actor?: string;
}

export interface ChangePlanResult {
  applied: "immediate" | "scheduled";
  effectiveAt?: Date | null;
  monthlyPrice: string;
  currency: string;
  includedCredits: number;
}

/**
 * Change plan and/or volume selection.
 *
 * The client sends KEYS only. `quote()` re-derives price, credits and estimate
 * server-side from the catalog, so a tampered payload cannot buy AI Voice at
 * Foundation's price.
 *
 * Direction decides timing: anything that RAISES what the customer pays applies
 * immediately with a prorated charge; anything that LOWERS it is deferred to
 * period end, so a downgrade never takes away capability the customer has
 * already paid for.
 */
export async function changePlan(input: ChangePlanInput): Promise<ChangePlanResult> {
  const entityId = await getEntityIdForTenant(input.tenantId);
  if (!entityId) throw new Error("no billable entity");
  const sub = await prisma.subscription.findUnique({ where: { billableEntityId: entityId } });
  if (!sub) throw new Error("no subscription");

  await assertSelectable(input.targetPlanKey, input.tenantId);
  const target = (await getActivePlanVersion(input.targetPlanKey)) ?? (await getPlan(input.targetPlanKey));
  if (!target) throw new Error(`unknown plan ${input.targetPlanKey}`);

  const samePlan = sub.planKey === target.key;
  const defaults = await defaultVolumeKeys(target.id, target);
  // On the SAME plan, keep the current selection unless the caller changes it.
  // On a DIFFERENT plan, an unspecified selector falls back to that plan's
  // default rather than carrying over a key that may not exist there.
  const chatKey =
    input.chatVolumeOptionKey !== undefined
      ? input.chatVolumeOptionKey
      : samePlan
        ? sub.chatVolumeOptionKey
        : defaults.chatVolumeOptionKey;
  const voiceKey =
    input.voiceVolumeOptionKey !== undefined
      ? input.voiceVolumeOptionKey
      : samePlan
        ? sub.voiceVolumeOptionKey
        : defaults.voiceVolumeOptionKey;

  const q = await quote({
    planKey: target.key,
    planVersion: target.version,
    chatVolumeOptionKey: chatKey,
    voiceVolumeOptionKey: voiceKey,
    tenantId: input.tenantId,
  });

  const fromPlan = await getPlan(sub.planKey, sub.planVersion);
  const currentPrice = contractedPrice(sub, fromPlan);
  const newPrice = Number(q.monthlyPrice.minor) / 100;

  // "Up" means the customer will pay more - whether that came from a higher
  // tier or from a bigger volume selector on the same tier.
  const tierUp = samePlan ? false : await isUpgrade(sub.planKey, target.key, sub.planVersion, target.version);
  const goingUp = newPrice > currentPrice || (tierUp && newPrice >= currentPrice);

  const snapshot = snapshotFor(q);
  const priceString = snapshot.snapshotPrice;

  if (goingUp) {
    const periodKey = sub.currentPeriodStart ? periodKeyFor(sub.currentPeriodStart) : periodKeyFor(new Date());
    const periodEnd = sub.currentPeriodEnd ?? new Date();
    const tenantId = input.tenantId;

    // Charge the prorated difference FIRST. Granting the new plan's features and
    // credits on a failed charge would hand out paid entitlements to a declined
    // card. A TRIALING subscription has no money due yet, so it upgrades without
    // an immediate charge and the higher price lands at trial-end activation.
    const proration = Math.max(0, newPrice - currentPrice);
    const chargeDue = proration > 0 && sub.status !== "TRIALING";
    if (chargeDue) {
      // Scope the idempotency key to the payment method that will be charged.
      // A failed attempt (no/declined card) must not permanently block a retry
      // after the customer adds a valid card; a double-click on the SAME card
      // stays idempotent because the key is identical.
      const billingProfile = await prisma.billingProfile.findUnique({
        where: { billableEntityId: entityId },
        include: { paymentMethods: { where: { status: "ACTIVE" }, orderBy: { isDefault: "desc" }, take: 1 } },
      });
      const pmKey = billingProfile?.paymentMethods[0]?.id ?? "nocard";
      const selection = [chatKey, voiceKey].filter(Boolean).join("+") || "base";
      const res = await chargeFor({
        entityId,
        tenantId,
        type: "SUBSCRIPTION",
        amount: proration,
        currency: q.currency,
        description: samePlan ? `${target.name} volume change (prorated)` : `Upgrade to ${target.name} (prorated)`,
        idempotencyKey: `upgrade:${sub.id}:${periodKey}:${target.key}:${target.version}:${selection}:${pmKey}`,
      });
      if (res.outcomeUnknown) {
        // The plan is NOT flipped - we cannot confirm they paid for it. But
        // telling them the payment failed would be worse than saying nothing:
        // they may have been charged, and "failed" invites them to try again.
        // Flagged for reconciliation, which can complete the upgrade once the
        // provider's own records settle it.
        await emitBillingEvent({
          type: "payment.reconciliation_required",
          tenantId,
          data: { invoiceId: res.invoiceId, context: "upgrade", targetPlan: target.key },
        });
        throw new Error("upgrade_payment_outcome_unknown");
      }
      if (!res.success) {
        await emitBillingEvent({ type: "payment.failed", tenantId, data: { invoiceId: res.invoiceId, reason: res.failureCode, context: "upgrade", targetPlan: target.key } });
        throw new Error(`upgrade_payment_failed:${res.failureCode ?? "charge_failed"}`);
      }
    }

    // Payment settled (or nothing due) → now it is safe to flip the plan, write
    // the new commercial snapshot, recompute entitlements and top up credits.
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { planKey: target.key, planVersion: target.version, billingInterval: target.billingInterval, ...snapshot },
    });
    await materializeForEntity(entityId, input.actor);
    const bal = await getBalance(tenantId);
    const delta = Math.max(0, q.includedCredits - bal.includedAllowance);
    if (delta > 0) {
      await grantUnits({
        tenantId, bucket: "INCLUDED", grantType: "PLAN", units: delta, periodKey,
        expiresAt: periodEnd, source: `upgrade:${target.key}`, includedAllowance: q.includedCredits,
      });
    }
    await recordEvent(sub.id, "plan_changed", sub.status, sub.status, input.actor, {
      from: sub.planKey, to: target.key, version: target.version, chatKey, voiceKey, kind: samePlan ? "volume_up" : "upgrade",
    });
    await emitBillingEvent({ type: "subscription.plan_changed", tenantId, data: { from: sub.planKey, to: target.key, when: "immediate" } });
    return { applied: "immediate", monthlyPrice: priceString, currency: q.currency, includedCredits: q.includedCredits };
  }

  // Going down → deferred to period end. The current plan, its features, its
  // limits and its credits all stay exactly as they are until then.
  const effectiveAt = sub.currentPeriodEnd ?? new Date();
  const changeType = samePlan ? "VOLUME_CHANGE" : "DOWNGRADE";
  await prisma.pendingSubscriptionChange.upsert({
    where: { subscriptionId: sub.id },
    create: {
      subscriptionId: sub.id, changeType, targetPlanKey: target.key, targetPlanVersion: target.version,
      targetChatVolumeKey: chatKey, targetVoiceVolumeKey: voiceKey, effectiveAt, createdBy: input.actor,
    },
    update: {
      changeType, targetPlanKey: target.key, targetPlanVersion: target.version,
      targetChatVolumeKey: chatKey, targetVoiceVolumeKey: voiceKey, effectiveAt, createdBy: input.actor, appliedAt: null,
    },
  });
  await recordEvent(sub.id, samePlan ? "volume_change_scheduled" : "downgrade_scheduled", sub.status, sub.status, input.actor, {
    to: target.key, chatKey, voiceKey, effectiveAt,
  });
  await emitBillingEvent({
    type: "subscription.plan_changed",
    tenantId: input.tenantId,
    data: { from: sub.planKey, to: target.key, when: "period_end", effectiveAt },
  });
  return { applied: "scheduled", effectiveAt, monthlyPrice: priceString, currency: q.currency, includedCredits: q.includedCredits };
}

/** Change only the chat/voice volume selection on the current plan. */
export async function changeVolume(input: {
  tenantId: string;
  chatVolumeOptionKey?: string | null;
  voiceVolumeOptionKey?: string | null;
  actor?: string;
}): Promise<ChangePlanResult> {
  const entityId = await getEntityIdForTenant(input.tenantId);
  if (!entityId) throw new Error("no billable entity");
  const sub = await prisma.subscription.findUnique({ where: { billableEntityId: entityId } });
  if (!sub) throw new Error("no subscription");
  return changePlan({ ...input, targetPlanKey: sub.planKey });
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

/** Apply downgrades / volume changes / cancels whose effectiveAt has passed. */
export async function applyDuePendingChanges(now = new Date()): Promise<number> {
  const due = await prisma.pendingSubscriptionChange.findMany({
    where: { appliedAt: null, effectiveAt: { lte: now } },
    include: { subscription: true },
  });
  let applied = 0;
  for (const change of due) {
    const sub = change.subscription;
    const tenantId = (await tenantsForEntity(sub.billableEntityId))[0];

    if (change.changeType === "CANCEL") {
      await prisma.subscription.update({ where: { id: sub.id }, data: { status: "CANCELED" } });
      await recordEvent(sub.id, "canceled", sub.status, "CANCELED", "scheduler");
    } else if (
      (change.changeType === "DOWNGRADE" || change.changeType === "VOLUME_CHANGE" || change.changeType === "UPGRADE") &&
      change.targetPlanKey
    ) {
      const target = await getPlan(change.targetPlanKey, change.targetPlanVersion ?? 1);
      if (target) {
        const period = currentPeriod(sub.currentPeriodEnd ?? now);
        // Re-quote at application time and write a FRESH snapshot: the terms
        // that take effect now are the ones the subscription is contracted to
        // from here on, and they must be recorded, not recomputed later.
        const q = await quote({
          planKey: target.key,
          planVersion: target.version,
          chatVolumeOptionKey: change.targetChatVolumeKey,
          voiceVolumeOptionKey: change.targetVoiceVolumeKey,
          tenantId,
        });
        await prisma.subscription.update({
          where: { id: sub.id },
          data: {
            planKey: target.key,
            planVersion: target.version,
            currentPeriodStart: period.start,
            currentPeriodEnd: period.end,
            billingInterval: target.billingInterval,
            ...snapshotFor(q),
          },
        });
        await materializeForEntity(sub.billableEntityId, "scheduler");
        await grantIncludedForEntity(sub.billableEntityId, q.includedCredits, period.key, period.end, `${change.changeType.toLowerCase()}:${target.key}`);
        await recordEvent(sub.id, `${change.changeType.toLowerCase()}_applied`, sub.status, sub.status, "scheduler", {
          to: target.key, chatKey: change.targetChatVolumeKey, voiceKey: change.targetVoiceVolumeKey,
        });
      }
    }
    await prisma.pendingSubscriptionChange.update({ where: { id: change.id }, data: { appliedAt: now } });
    applied++;
  }
  return applied;
}

/** Charge trials whose window ended; renew active subs whose period ended. */
export async function runBillingCycle(now = new Date()): Promise<{
  trials: number;
  renewals: number;
  pending: number;
  pocsExpired: number;
  lotsExpired: number;
}> {
  const pending = await applyDuePendingChanges(now);

  const trials = await prisma.subscription.findMany({ where: { status: "TRIALING", trialEndsAt: { lte: now } } });
  for (const s of trials) await activateOrRenew(s.id, { reason: "trial_end" });

  const renewals = await prisma.subscription.findMany({ where: { status: "ACTIVE", cancelAtPeriodEnd: false, currentPeriodEnd: { lte: now } } });
  for (const s of renewals) await activateOrRenew(s.id, { reason: "renewal" });

  // POCs never renew (cancelAtPeriodEnd=true keeps them out of the sweep
  // above); expiring them is their entire lifecycle.
  const pocsExpired = await expireDuePocs(now);

  // Credit lots carrying their own expiry - a package with a DAYS_AFTER_PURCHASE
  // or PERIOD_END policy, and trial/POC grants. `rolloverIncluded` only handles
  // the previous period's included allowance, so without this sweep an expiring
  // purchased lot would keep counting toward the balance forever.
  const { expiredLots } = await expireDueLots(now);

  // Refresh the representative FX rate on the schedule, so a pricing page never
  // triggers an outbound request while rendering.
  await refreshUsdIlsRate(now).catch((err) =>
    console.warn("[billing][cycle] FX refresh failed:", err?.message ?? err),
  );

  return { trials: trials.length, renewals: renewals.length, pending, pocsExpired, lotsExpired: expiredLots };
}
