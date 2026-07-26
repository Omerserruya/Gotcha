/**
 * Credit purchases - manual and automatic.
 *
 * Purchased credits are PURCHASED-bucket lots (FIFO after the included
 * allowance). The wallet is the only place credits are created; nothing here
 * writes a balance directly.
 *
 * Auto-purchase is the money-moving path that runs without a human present, so
 * it is the one that has to be paranoid. Every attempt:
 *
 *   1. claims a single-flight lock on the policy row (CAS, with a reclaimable
 *      TTL so a crashed worker cannot wedge auto-purchase forever);
 *   2. RE-READS the month's spend inside the lock, rather than trusting the
 *      value it saw before acquiring it;
 *   3. re-validates the subscription, plan eligibility, payment method and
 *      credit shortage;
 *   4. charges the provider, and only credits the wallet after the provider
 *      confirms;
 *   5. writes the spend and releases the lock.
 *
 * Before this, two concurrent threshold crossings could both read the same
 * `monthSpentAmount`, both pass the ceiling check, and both charge - overshooting
 * the customer's configured monthly limit.
 */
import { prisma, grantUnits, getBalance } from "@chatcenter/shared";
import { getEntityIdForTenant } from "./billable-entity.service";
import { chargeFor } from "./invoice.service";
import { emitBillingEvent } from "../lib/events";
import { periodKeyFor } from "../lib/period";

export interface PurchaseResult {
  success: boolean;
  units?: number;
  invoiceId?: string;
  failureCode?: string;
  /** Present when the attempt was refused before any money moved. */
  detail?: Record<string, unknown>;
}

/** How long a purchase lock is honoured before another worker may reclaim it. */
const LOCK_TTL_MS = 60_000;

// ── Package resolution ──────────────────────────────────────────────────────

async function getPackage(key: string) {
  return prisma.creditPackage.findUnique({ where: { key } });
}

/** Is a package currently on sale, and available on this organization's plan? */
export function packageAvailable(
  pkg: { active: boolean; status: string; activeFrom: Date | null; activeTo: Date | null; eligiblePlanKeys: unknown },
  planKey: string | null,
  now = new Date(),
): { ok: boolean; reason?: string } {
  if (!pkg.active) return { ok: false, reason: "package_inactive" };
  if (pkg.activeFrom && pkg.activeFrom > now) return { ok: false, reason: "package_not_yet_active" };
  if (pkg.activeTo && pkg.activeTo <= now) return { ok: false, reason: "package_expired" };
  const eligible = pkg.eligiblePlanKeys;
  if (Array.isArray(eligible) && eligible.length > 0) {
    if (!planKey || !eligible.includes(planKey)) return { ok: false, reason: "package_not_eligible_for_plan" };
  }
  return { ok: true };
}

/** The price in force right now, honouring a scheduled future price. */
export function effectivePackagePrice(
  pkg: { price: unknown; scheduledPrice: unknown; scheduledPriceFrom: Date | null },
  now = new Date(),
): number {
  if (pkg.scheduledPrice != null && pkg.scheduledPriceFrom && pkg.scheduledPriceFrom <= now) {
    return Number(pkg.scheduledPrice);
  }
  return Number(pkg.price);
}

/** When purchased credits from this package expire, per its policy. */
export function packageExpiry(
  pkg: { expiryPolicy: string; expiryDays: number | null },
  periodEnd: Date | null,
  now = new Date(),
): Date | null {
  if (pkg.expiryPolicy === "DAYS_AFTER_PURCHASE" && pkg.expiryDays && pkg.expiryDays > 0) {
    return new Date(now.getTime() + pkg.expiryDays * 86_400_000);
  }
  if (pkg.expiryPolicy === "PERIOD_END") return periodEnd;
  return null;
}

async function subscriptionFor(entityId: string) {
  return prisma.subscription.findUnique({ where: { billableEntityId: entityId } });
}

async function planFor(sub: { planKey: string; planVersion: number } | null) {
  if (!sub) return null;
  return prisma.plan.findUnique({ where: { key_version: { key: sub.planKey, version: sub.planVersion } } });
}

// ── Manual purchase ─────────────────────────────────────────────────────────

/**
 * Customer-initiated credit purchase.
 *
 * The client sends a package KEY and a quantity, never a price or a credit
 * amount: both are read from the catalog here, so a tampered payload cannot buy
 * 50,000 credits for $25.
 */
export async function buyCredits(input: {
  tenantId: string;
  packageKey: string;
  quantity?: number;
  actor?: string;
}): Promise<PurchaseResult> {
  const entityId = await getEntityIdForTenant(input.tenantId);
  if (!entityId) return { success: false, failureCode: "no_billable_entity" };

  const pkg = await getPackage(input.packageKey);
  if (!pkg) return { success: false, failureCode: "unknown_package" };

  const sub = await subscriptionFor(entityId);
  const plan = await planFor(sub);

  const availability = packageAvailable(pkg, sub?.planKey ?? null);
  if (!availability.ok) return { success: false, failureCode: availability.reason };

  if (plan && !plan.creditPackagesEligible) {
    return { success: false, failureCode: "plan_not_eligible_for_packages" };
  }

  const quantity = Math.max(1, Math.floor(input.quantity ?? 1));
  if (pkg.maxPurchaseQuantity != null && quantity > pkg.maxPurchaseQuantity) {
    return { success: false, failureCode: "quantity_exceeds_maximum", detail: { max: pkg.maxPurchaseQuantity } };
  }

  const unitPrice = effectivePackagePrice(pkg);
  const amount = unitPrice * quantity;
  const units = pkg.units * quantity;

  const idempotencyKey = `buy:${entityId}:${pkg.key}:${quantity}:${Date.now()}`;
  const res = await chargeFor({
    entityId,
    tenantId: input.tenantId,
    type: "CREDIT_PURCHASE",
    amount,
    currency: pkg.currency,
    description: quantity > 1 ? `${pkg.name} x${quantity}` : pkg.name,
    idempotencyKey,
  });
  if (!res.success) return { success: false, invoiceId: res.invoiceId, failureCode: res.failureCode };

  // Credits are granted ONLY after the provider confirms.
  await grantUnits({
    tenantId: input.tenantId,
    bucket: "PURCHASED",
    grantType: "PURCHASE",
    units,
    source: `package:${pkg.key}`,
    referenceId: res.invoiceId,
    expiresAt: packageExpiry(pkg, sub?.currentPeriodEnd ?? null),
  });
  return { success: true, units, invoiceId: res.invoiceId };
}

// ── Single-flight lock ──────────────────────────────────────────────────────

/**
 * Claim the policy's purchase lock with a compare-and-set.
 *
 * `updateMany` with the lock predicate in the WHERE clause IS the CAS: exactly
 * one concurrent caller matches a row and gets count 1, the rest get 0. A lock
 * older than the TTL is reclaimable.
 */
async function acquireLock(billableEntityId: string, token: string, now: Date): Promise<boolean> {
  const staleBefore = new Date(now.getTime() - LOCK_TTL_MS);
  const claimed = await prisma.autoPurchasePolicy.updateMany({
    where: {
      billableEntityId,
      OR: [{ lockedAt: null }, { lockedAt: { lt: staleBefore } }],
    },
    data: { lockedAt: now, lockToken: token },
  });
  return claimed.count === 1;
}

async function releaseLock(billableEntityId: string, token: string): Promise<void> {
  await prisma.autoPurchasePolicy
    .updateMany({ where: { billableEntityId, lockToken: token }, data: { lockedAt: null, lockToken: null } })
    .catch(() => {});
}

// ── Automatic purchase ──────────────────────────────────────────────────────

/**
 * Top up credits when the balance crosses the policy threshold.
 *
 * Returns a failure code rather than throwing: this runs on the tail of the AI
 * hot path's threshold notification, and a refusal to auto-purchase must never
 * take down a customer turn.
 */
export async function triggerAutoPurchase(input: { tenantId: string; reason?: string }): Promise<PurchaseResult> {
  const now = new Date();
  const entityId = await getEntityIdForTenant(input.tenantId);
  if (!entityId) return { success: false, failureCode: "no_billable_entity" };

  const pre = await prisma.autoPurchasePolicy.findUnique({ where: { billableEntityId: entityId } });
  if (!pre || !pre.enabled) return { success: false, failureCode: "auto_purchase_disabled" };
  if (pre.limitBehavior === "PREPAID_ONLY") return { success: false, failureCode: "prepaid_only" };

  const token = `${process.pid}:${now.getTime()}:${Math.floor(now.getTime() % 100000)}`;
  if (!(await acquireLock(entityId, token, now))) {
    // Another attempt is already in flight for this organization. Refusing here
    // is what keeps two concurrent threshold crossings from both charging.
    return { success: false, failureCode: "purchase_in_progress" };
  }

  try {
    // Re-read EVERYTHING inside the lock. Values seen before acquiring it are
    // not safe to spend against.
    const policy = await prisma.autoPurchasePolicy.findUnique({ where: { billableEntityId: entityId } });
    if (!policy || !policy.enabled) return { success: false, failureCode: "auto_purchase_disabled" };

    const sub = await subscriptionFor(entityId);
    if (!sub) return { success: false, failureCode: "no_subscription" };
    if (!["ACTIVE", "TRIALING", "PAST_DUE"].includes(sub.status)) {
      return { success: false, failureCode: `subscription_${sub.status.toLowerCase()}` };
    }

    const plan = await planFor(sub);
    if (plan && !plan.autoPurchaseEligible) {
      return { success: false, failureCode: "plan_not_eligible_for_auto_purchase" };
    }

    const profile = await prisma.billingProfile.findUnique({
      where: { billableEntityId: entityId },
      include: { paymentMethods: { where: { status: "ACTIVE" }, take: 1 } },
    });
    if (!profile || profile.paymentMethods.length === 0) {
      await emitBillingEvent({ type: "credit.auto_purchase_failed", tenantId: input.tenantId, data: { reason: "no_payment_method" } });
      return { success: false, failureCode: "no_payment_method" };
    }

    // Only top up when there is an actual shortage. A threshold notification
    // that arrives after a manual purchase must not trigger a second charge.
    const balance = await getBalance(input.tenantId);
    const thresholdUnits = (balance.includedAllowance * policy.thresholdPct) / 100;
    if (balance.total > thresholdUnits) {
      return { success: false, failureCode: "no_shortage", detail: { balance: balance.total, thresholdUnits } };
    }

    const topUp = await resolveTopUp(policy, sub, now);
    if (topUp.units <= 0) return { success: false, failureCode: "no_top_up_configured" };

    const monthKey = periodKeyFor(now);
    const spentThisMonth = policy.monthSpendKey === monthKey ? Number(policy.monthSpentAmount) : 0;
    const ceiling = policy.maxMonthlySpend != null ? Number(policy.maxMonthlySpend) : Infinity;

    if (spentThisMonth + topUp.amount > ceiling) {
      await emitBillingEvent({
        type: "credit.auto_purchase_ceiling_reached",
        tenantId: input.tenantId,
        data: {
          amount: topUp.amount,
          spentThisMonth,
          ceiling,
          limitBehavior: policy.limitBehavior,
          manualPurchasePath: "/settings/billing/credits",
        },
      });
      return { success: false, failureCode: "monthly_ceiling_reached", detail: { spentThisMonth, ceiling } };
    }

    // Minute-bucketed idempotency key: a retry storm within the same minute is
    // deduped by the provider, while a legitimate later top-up is not blocked.
    const idempotencyKey = `auto:${entityId}:${monthKey}:${topUp.units}:${Math.floor(now.getTime() / 60000)}`;
    const res = await chargeFor({
      entityId,
      tenantId: input.tenantId,
      type: "AUTO_PURCHASE",
      amount: topUp.amount,
      currency: topUp.currency,
      description: `Auto top-up: ${topUp.label}`,
      idempotencyKey,
    });

    if (!res.success) {
      await emitBillingEvent({ type: "credit.auto_purchase_failed", tenantId: input.tenantId, data: { reason: res.failureCode, amount: topUp.amount } });
      return { success: false, invoiceId: res.invoiceId, failureCode: res.failureCode };
    }

    await grantUnits({
      tenantId: input.tenantId,
      bucket: "PURCHASED",
      grantType: "AUTO",
      units: topUp.units,
      source: topUp.packageKey ? `auto:${topUp.packageKey}` : "auto:increment",
      referenceId: res.invoiceId,
      expiresAt: topUp.expiresAt,
    });

    await prisma.autoPurchasePolicy.update({
      where: { billableEntityId: entityId },
      data: {
        monthSpendKey: monthKey,
        monthSpentAmount: (spentThisMonth + topUp.amount).toFixed(2),
        lastTriggeredAt: now,
      },
    });

    await emitBillingEvent({
      type: "credit.auto_purchase_succeeded",
      tenantId: input.tenantId,
      data: { units: topUp.units, amount: topUp.amount, currency: topUp.currency, invoiceId: res.invoiceId, reason: input.reason },
    });
    return { success: true, units: topUp.units, invoiceId: res.invoiceId };
  } finally {
    await releaseLock(entityId, token);
  }
}

/**
 * What one automatic top-up buys.
 *
 * An increment + price-per-credit policy takes precedence over a fixed package:
 * it is the more precise instrument, and a customer who configured both meant
 * the one they can tune.
 */
async function resolveTopUp(
  policy: { incrementCredits: number | null; pricePerCredit: unknown; packageKey: string | null; currency: string },
  sub: { currentPeriodEnd: Date | null },
  now: Date,
): Promise<{ units: number; amount: number; currency: string; label: string; expiresAt: Date | null; packageKey: string | null }> {
  if (policy.incrementCredits && policy.incrementCredits > 0 && policy.pricePerCredit != null) {
    const units = policy.incrementCredits;
    const perCredit = Number(policy.pricePerCredit);
    return {
      units,
      // Round to whole minor units so the charged amount is never a fraction of
      // a cent the provider rounds differently than we recorded.
      amount: Math.round(units * perCredit * 100) / 100,
      currency: policy.currency,
      label: `${units.toLocaleString()} credits`,
      expiresAt: null,
      packageKey: null,
    };
  }

  if (policy.packageKey) {
    const pkg = await getPackage(policy.packageKey);
    if (pkg && pkg.active) {
      return {
        units: pkg.units,
        amount: effectivePackagePrice(pkg, now),
        currency: pkg.currency,
        label: pkg.name,
        expiresAt: packageExpiry(pkg, sub.currentPeriodEnd, now),
        packageKey: pkg.key,
      };
    }
  }

  return { units: 0, amount: 0, currency: policy.currency, label: "", expiresAt: null, packageKey: null };
}

/**
 * What the AI runtime should do once credits are exhausted and no further
 * auto-purchase is possible. Read by the enforcement gate and surfaced to the
 * customer, so the configured behaviour is visible rather than a mystery.
 */
export async function resolveExhaustionBehavior(tenantId: string): Promise<string> {
  const entityId = await getEntityIdForTenant(tenantId);
  if (!entityId) return "STOP_AI";
  const policy = await prisma.autoPurchasePolicy.findUnique({ where: { billableEntityId: entityId } });
  return policy?.limitBehavior ?? "STOP_AI";
}
