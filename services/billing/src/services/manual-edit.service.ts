/**
 * Console manual edits: a SYSTEM_ADMIN changes a tenant's plan or end date,
 * moves it to a POC, or adds credits - and nobody is charged for any of it
 * (Omer, 2026-10-23).
 *
 * Nothing here calls chargeFor. The harder half is that nothing may charge
 * LATER because of an edit made here, and the billing cycle charges three ways:
 *
 *   - renewal: an ACTIVE subscription with cancelAtPeriodEnd=false is charged at
 *     currentPeriodEnd. Every edit here sets cancelAtPeriodEnd=true.
 *   - trial conversion: a TRIALING subscription is charged at trialEndsAt,
 *     whatever cancelAtPeriodEnd says. Every edit here leaves ACTIVE with
 *     trialEndsAt=null.
 *   - dunning: a PAST_DUE subscription is retried. Refused here rather than
 *     quietly stopped, so a debt is never cleared by a plan edit.
 *
 * A paid plan's end date is a scheduled CANCEL at that date, so access stops on
 * the day the operator chose instead of renewing. An evaluation (POC / TRIAL)
 * already ends at currentPeriodEnd through expireDuePocs, which also emails the
 * customer - which is why a date in the past is refused, never applied.
 *
 * Any pending change (a scheduled downgrade, cancel or volume change) is
 * replaced: left in place, applyDuePendingChanges would overwrite this edit at
 * its effective date. Shopify-billed tenants are refused, because Shopify owns
 * their plan and reconcileProviderSubscriptions mirrors it back.
 *
 * Deliberately emits no customer-facing billing event. These are operator
 * corrections; telling the customer is the operator's call, not a side effect.
 */
import { prisma, grantUnits, getBalance, materializeEntitlements } from "@chatcenter/shared";
import { ensureBillableEntity, getEntityIdForTenant, tenantsForEntity } from "./billable-entity.service";
import { resolveAndValidatePlan, ProvisioningRefused } from "./paid-provisioning.service";
import { quote, snapshotFor } from "./pricing.service";
import { provisionPoc, PocProvisioningRefused } from "./poc.service";
import { periodKeyFor } from "../lib/period";

export class ManualEditRefused extends Error {
  constructor(public code: string, public detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

/** Checkout states that mean a customer could still pay and replace the plan. */
const OPEN_CHECKOUT_STATES = ["PENDING", "AWAITING_PROVIDER", "TOKENIZED"];

/** Subscription states a manual edit may start from. */
const EDITABLE_STATES = ["ACTIVE", "TRIALING", "CANCELED"];

export interface SubscriptionView {
  planKey: string;
  planVersion: number;
  planKind: string | null;
  status: string;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  trialEndsAt: Date | null;
  price: string | null;
  currency: string | null;
}

export interface ManualEditResult {
  before: SubscriptionView | null;
  after: SubscriptionView | null;
  /**
   * Said plainly so the console can show it. "off" after every plan or date
   * edit; "unchanged" after a credit grant, which does not touch the renewal.
   */
  renewal: "off" | "unchanged";
  charges: "none";
  /** The pending change this edit replaced, if there was one. */
  pendingChangeCleared: { changeType: string; targetPlanKey: string | null; effectiveAt: Date } | null;
  balanceBefore?: unknown;
  balanceAfter?: unknown;
  warnings: string[];
  poc?: { featuresEnabled: string[]; featuresDenied: string[] };
}

async function view(sub: any | null): Promise<SubscriptionView | null> {
  if (!sub) return null;
  const plan = await prisma.plan.findFirst({
    where: { key: sub.planKey, version: sub.planVersion },
    select: { kind: true },
  });
  return {
    planKey: sub.planKey,
    planVersion: sub.planVersion,
    planKind: plan?.kind ?? null,
    status: sub.status,
    currentPeriodEnd: sub.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: !!sub.cancelAtPeriodEnd,
    trialEndsAt: sub.trialEndsAt ?? null,
    price: sub.snapshotPrice != null ? String(sub.snapshotPrice) : null,
    currency: sub.snapshotCurrency ?? null,
  };
}

async function currentSubscription(tenantId: string) {
  const entityId = await getEntityIdForTenant(tenantId);
  if (!entityId) return null;
  return prisma.subscription.findUnique({ where: { billableEntityId: entityId } });
}

/** The refusals every plan or date edit shares. */
async function assertEditable(tenantId: string, sub: any | null): Promise<void> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
  if (!tenant) throw new ManualEditRefused("tenant_not_found");

  const shopify = await prisma.providerSubscription.findFirst({
    where: { tenantId, billingSource: "SHOPIFY", status: { notIn: ["DECLINED", "EXPIRED"] as any } },
    select: { id: true },
  });
  if (shopify || sub?.billingSource === "SHOPIFY") throw new ManualEditRefused("shopify_billed");

  if (!sub) return;
  const dunning = await prisma.dunningState.findUnique({ where: { subscriptionId: sub.id }, select: { id: true } });
  if (sub.status === "PAST_DUE" || dunning) throw new ManualEditRefused("in_dunning");
  if (sub.status === "GRANDFATHERED") throw new ManualEditRefused("grandfathered");
  if (!EDITABLE_STATES.includes(sub.status)) throw new ManualEditRefused("subscription_state_not_editable", sub.status);
}

function assertFuture(endsAt: Date | null | undefined, now: Date): asserts endsAt is Date {
  if (!endsAt || Number.isNaN(endsAt.getTime())) throw new ManualEditRefused("end_date_required");
  // A past end on an evaluation would cancel it and email the customer at the
  // next tick, and on a paid plan it would end access at once. Refused, not
  // confirmed: an operator who means "end it now" can pick tomorrow.
  if (endsAt.getTime() <= now.getTime()) throw new ManualEditRefused("end_date_in_past");
}

async function warningsFor(tenantId: string): Promise<string[]> {
  const warnings: string[] = [];
  const checkout = await prisma.pendingCheckout.findFirst({
    where: { tenantId, status: { in: OPEN_CHECKOUT_STATES as any } },
    select: { id: true },
  });
  // A customer completing that checkout activates ITS plan over this one.
  if (checkout) warnings.push("open_checkout");
  return warnings;
}

async function pendingChange(subscriptionId: string) {
  const p = await prisma.pendingSubscriptionChange.findUnique({ where: { subscriptionId } });
  if (!p || p.appliedAt) return null;
  return { changeType: p.changeType as string, targetPlanKey: p.targetPlanKey ?? null, effectiveAt: p.effectiveAt };
}

async function recordManualEvent(sub: any, type: string, to: string, actor: string | undefined, metadata: Record<string, unknown>) {
  await prisma.subscriptionEvent.create({
    data: { subscriptionId: sub.id, type, fromStatus: sub.status, toStatus: to as any, actor: actor ?? "system", metadata: metadata as any },
  });
}

async function materializeTenants(entityId: string, actor?: string) {
  for (const t of await tenantsForEntity(entityId)) await materializeEntitlements(t, actor);
}

// ── change_plan ──────────────────────────────────────────────────────────────

export async function manualChangePlan(input: {
  tenantId: string;
  planVersionId: string;
  chatVolumeOptionKey?: string | null;
  voiceVolumeOptionKey?: string | null;
  endsAt?: Date | null;
  actor?: string;
  reason: string;
}, now = new Date()): Promise<ManualEditResult> {
  const sub = await currentSubscription(input.tenantId);
  await assertEditable(input.tenantId, sub);

  let plan;
  try {
    plan = await resolveAndValidatePlan({
      planVersionId: input.planVersionId,
      chatVolumeOptionKey: input.chatVolumeOptionKey ?? null,
      voiceVolumeOptionKey: input.voiceVolumeOptionKey ?? null,
    });
  } catch (err) {
    if (err instanceof ProvisioningRefused) throw new ManualEditRefused(err.code);
    throw err;
  }

  // Keep a live paid period's end unless the operator names another one; a
  // subscription with no future end needs one, because "until when" is the
  // only thing that stops a no-charge plan from being free product forever.
  const keep = sub?.status !== "CANCELED" && sub?.currentPeriodEnd && sub.currentPeriodEnd > now ? sub.currentPeriodEnd : null;
  const endsAt = input.endsAt ?? keep;
  assertFuture(endsAt, now);

  const q = await quote({
    planKey: plan.key,
    planVersion: plan.version,
    chatVolumeOptionKey: input.chatVolumeOptionKey ?? null,
    voiceVolumeOptionKey: input.voiceVolumeOptionKey ?? null,
    tenantId: input.tenantId,
  });

  const entityId = await ensureBillableEntity(input.tenantId);
  const before = await view(sub);
  const cleared = sub ? await pendingChange(sub.id) : null;
  const periodStart = sub && sub.status !== "CANCELED" && sub.currentPeriodStart ? sub.currentPeriodStart : now;

  const terms = {
    planKey: plan.key,
    planVersion: plan.version,
    billingInterval: plan.billingInterval,
    ...snapshotFor(q),
    status: "ACTIVE" as const,
    trialEndsAt: null,
    cancelAtPeriodEnd: true,
    currentPeriodStart: periodStart,
    currentPeriodEnd: endsAt,
  };

  const updated = await prisma.$transaction(async (tx) => {
    const s = await tx.subscription.upsert({
      where: { billableEntityId: entityId },
      create: { billableEntityId: entityId, enforcementEnabled: true, ...terms },
      update: terms,
    });
    // One row per subscription: the upsert REPLACES whatever was pending.
    await tx.pendingSubscriptionChange.upsert({
      where: { subscriptionId: s.id },
      create: { subscriptionId: s.id, changeType: "CANCEL", effectiveAt: endsAt, createdBy: input.actor },
      update: {
        changeType: "CANCEL", targetPlanKey: null, targetPlanVersion: null, targetChatVolumeKey: null,
        targetVoiceVolumeKey: null, effectiveAt: endsAt, createdBy: input.actor, appliedAt: null,
      },
    });
    return s;
  });
  await recordManualEvent(sub ?? updated, "manual_plan_change", "ACTIVE", input.actor, {
    from: sub?.planKey ?? null, to: plan.key, version: plan.version, endsAt, reason: input.reason, charges: "none",
  });

  await materializeTenants(entityId, input.actor);
  // The new plan's allowance for the period already running, as an upgrade
  // grants it - topped up to the plan's figure, never stacked past it.
  const bal = await getBalance(input.tenantId);
  const delta = Math.max(0, q.includedCredits - bal.includedAllowance);
  if (delta > 0) {
    await grantUnits({
      tenantId: input.tenantId, bucket: "INCLUDED", grantType: "PLAN", units: delta,
      periodKey: periodKeyFor(periodStart), expiresAt: endsAt, source: `manual:${plan.key}`,
      includedAllowance: q.includedCredits,
    });
  }

  return {
    before,
    after: await view(updated),
    renewal: "off",
    charges: "none",
    pendingChangeCleared: cleared,
    warnings: await warningsFor(input.tenantId),
  };
}

// ── set_end_date ─────────────────────────────────────────────────────────────

export async function manualSetEndDate(input: {
  tenantId: string;
  endsAt: Date;
  actor?: string;
  reason: string;
}, now = new Date()): Promise<ManualEditResult> {
  const sub = await currentSubscription(input.tenantId);
  await assertEditable(input.tenantId, sub);
  if (!sub) throw new ManualEditRefused("no_subscription");
  assertFuture(input.endsAt, now);

  const before = await view(sub);
  const evaluation = before?.planKind === "POC" || before?.planKind === "TRIAL";
  const cleared = await pendingChange(sub.id);
  const oldEnd = sub.currentPeriodEnd;

  const updated = await prisma.$transaction(async (tx) => {
    const s = await tx.subscription.update({
      where: { id: sub.id },
      data: {
        currentPeriodEnd: input.endsAt,
        // Revives an evaluation that already ended - "trial ended, give them
        // two more weeks" is the case this exists for.
        status: "ACTIVE",
        trialEndsAt: null,
        cancelAtPeriodEnd: true,
      },
    });
    if (evaluation) {
      // expireDuePocs ends an evaluation at currentPeriodEnd by itself; a
      // pending row would only be something else to apply over it.
      await tx.pendingSubscriptionChange.deleteMany({ where: { subscriptionId: sub.id, appliedAt: null } });
      // The POC's feature grants carry the POC's own expiry. Moving one without
      // the other leaves a live evaluation with its features switched off.
      if (oldEnd) {
        await tx.tenantEntitlement.updateMany({
          where: { tenantId: input.tenantId, source: "TRIAL", expiresAt: oldEnd },
          data: { expiresAt: input.endsAt },
        });
      }
    } else {
      await tx.pendingSubscriptionChange.upsert({
        where: { subscriptionId: sub.id },
        create: { subscriptionId: sub.id, changeType: "CANCEL", effectiveAt: input.endsAt, createdBy: input.actor },
        update: {
          changeType: "CANCEL", targetPlanKey: null, targetPlanVersion: null, targetChatVolumeKey: null,
          targetVoiceVolumeKey: null, effectiveAt: input.endsAt, createdBy: input.actor, appliedAt: null,
        },
      });
    }
    return s;
  });
  await recordManualEvent(sub, "manual_end_date", "ACTIVE", input.actor, {
    from: oldEnd, to: input.endsAt, reason: input.reason, charges: "none",
  });
  if (evaluation) await materializeTenants(sub.billableEntityId, input.actor);

  return {
    before,
    after: await view(updated),
    renewal: "off",
    charges: "none",
    pendingChangeCleared: cleared,
    warnings: await warningsFor(input.tenantId),
  };
}

// ── switch_to_poc ────────────────────────────────────────────────────────────

export async function manualSwitchToPoc(input: {
  tenantId: string;
  credits: number;
  expiresAt: Date;
  features: string[];
  actor?: string;
  reason: string;
}, now = new Date()): Promise<ManualEditResult> {
  const sub = await currentSubscription(input.tenantId);
  await assertEditable(input.tenantId, sub);
  assertFuture(input.expiresAt, now);

  const before = await view(sub);
  const cleared = sub ? await pendingChange(sub.id) : null;
  if (sub) await prisma.pendingSubscriptionChange.deleteMany({ where: { subscriptionId: sub.id, appliedAt: null } });

  let result;
  try {
    // The one POC path: subscription (cancelAtPeriodEnd, no price), budget and
    // the exact feature set, together or not at all.
    result = await provisionPoc({
      tenantId: input.tenantId,
      credits: input.credits,
      expiresAt: input.expiresAt,
      features: input.features,
      note: input.reason,
      actor: input.actor,
    });
  } catch (err) {
    if (err instanceof PocProvisioningRefused) throw new ManualEditRefused(err.code);
    throw err;
  }

  const after = await currentSubscription(input.tenantId);
  if (after) {
    await recordManualEvent(after, "manual_switch_to_poc", "ACTIVE", input.actor, {
      from: sub?.planKey ?? null, credits: input.credits, expiresAt: input.expiresAt, reason: input.reason, charges: "none",
    });
  }

  return {
    before,
    after: await view(after),
    renewal: "off",
    charges: "none",
    pendingChangeCleared: cleared,
    warnings: await warningsFor(input.tenantId),
    poc: { featuresEnabled: result.featuresEnabled, featuresDenied: result.featuresDenied },
  };
}

// ── add_credits ──────────────────────────────────────────────────────────────

export async function manualAddCredits(input: {
  tenantId: string;
  units: number;
  actor?: string;
  reason: string;
}): Promise<ManualEditResult> {
  const tenant = await prisma.tenant.findUnique({ where: { id: input.tenantId }, select: { id: true } });
  if (!tenant) throw new ManualEditRefused("tenant_not_found");
  if (!Number.isInteger(input.units) || input.units <= 0) throw new ManualEditRefused("units_must_be_positive");

  const sub = await currentSubscription(input.tenantId);
  const balanceBefore = await getBalance(input.tenantId);
  // PURCHASED bucket: never expires and is not reset by the monthly roll, which
  // only touches INCLUDED - the same bucket the console top-up always used.
  await grantUnits({
    tenantId: input.tenantId, bucket: "PURCHASED", grantType: "PROMO", units: input.units,
    source: `admin:${input.actor ?? "system"}`,
  });
  const snapshot = await view(sub);
  return {
    before: snapshot,
    after: snapshot,
    renewal: "unchanged",
    charges: "none",
    pendingChangeCleared: null,
    balanceBefore,
    balanceAfter: await getBalance(input.tenantId),
    warnings: [],
  };
}
