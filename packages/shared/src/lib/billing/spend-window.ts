/**
 * The one definition of "which spend window is this", and what pay-as-you-go
 * has left inside it.
 *
 * It lives in shared because two different processes need the same answer: the
 * billing service, which accrues and settles, and the AI gate, which decides
 * whether the next call may run at all. A gate that computed the window
 * differently from the accruer would let usage through that nothing bills, or
 * block usage that has budget left.
 *
 * The window is the SUBSCRIPTION's, never the calendar month's. That distinction
 * is the whole point: a customer anchored on the 10th whose cap resets on the
 * 1st can spend two ceilings inside one billing cycle.
 */
import { prisma } from "../prisma";

/** Stable key for a period, derived from its start (e.g. "2026-06"). */
export function periodKeyFor(start: Date): string {
  const y = start.getUTCFullYear();
  const m = String(start.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * The key for a subscription's current spend window.
 *
 * Pass the subscription, never `now`. Falls back to the wall-clock month only
 * when there is no period to anchor to, where the two agree anyway.
 */
export function spendWindowKey(
  sub: { currentPeriodStart: Date | null } | null | undefined,
  now: Date = new Date(),
): string {
  return sub?.currentPeriodStart ? periodKeyFor(sub.currentPeriodStart) : periodKeyFor(now);
}

export interface PaygAccess {
  /** PAYG is the configured behaviour AND a usable rate exists. */
  enabled: boolean;
  periodKey: string | null;
  accruedAmount: number;
  ceiling: number;
  /** Budget left in this window. 0 when capped, Infinity when uncapped. */
  headroom: number;
  currency: string;
  pricePerCredit: number;
}

export const PAYG_OFF: PaygAccess = {
  enabled: false, periodKey: null, accruedAmount: 0,
  ceiling: 0, headroom: 0, currency: "", pricePerCredit: 0,
};

/**
 * What PAYG can still cover for this organization.
 *
 * NEVER throws. A failure has to read as "PAYG is not available", which falls
 * through to the ordinary exhausted-wallet block. The opposite default would
 * turn a database blip into an unmetered tap.
 */
export async function readPaygAccess(tenantId: string, now: Date = new Date()): Promise<PaygAccess> {
  try {
    const link = await prisma.billableEntityTenant.findUnique({
      where: { tenantId },
      include: { entity: { include: { autoPurchasePolicy: true, subscription: true } } },
    });
    const entity = link?.entity;
    const policy = entity?.autoPurchasePolicy as any;
    if (!entity || !policy) return PAYG_OFF;
    if (policy.limitBehavior !== "PAYG") return PAYG_OFF;

    // A PAYG mode with no rate cannot price what it serves. Treating that as
    // "free" would be the most expensive bug in this file.
    const rate = policy.paygPricePerCredit != null ? Number(policy.paygPricePerCredit) : 0;
    if (!(rate > 0)) return PAYG_OFF;

    const periodKey = spendWindowKey(
      entity.subscription ? { currentPeriodStart: entity.subscription.currentPeriodStart } : null,
      now,
    );
    const accrual = await (prisma as any).paygAccrual.findUnique({
      where: { billableEntityId_periodKey: { billableEntityId: entity.id, periodKey } },
    });

    const accruedAmount = accrual ? Number(accrual.amount) : 0;
    const ceiling = policy.maxMonthlySpend != null ? Number(policy.maxMonthlySpend) : Infinity;
    const headroom = ceiling === Infinity ? Infinity : Math.max(0, ceiling - accruedAmount);

    return {
      enabled: true,
      periodKey,
      accruedAmount,
      ceiling,
      headroom,
      currency: accrual?.currency || policy.currency || "",
      pricePerCredit: rate,
    };
  } catch {
    return PAYG_OFF;
  }
}
