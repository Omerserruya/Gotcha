/**
 * Pay-as-you-go: the third way to pay for usage, and the only one that bills in
 * arrears.
 *
 * The other two are purchases. A one-off package and an auto top-up both charge
 * the card at the moment they happen, so the customer can never owe more than
 * they have already paid. PAYG is the opposite: the AI keeps working past a
 * spent wallet and the bill is drawn when the cycle closes.
 *
 * That inversion is the whole design problem here, and it drives three rules:
 *
 *   1. THE CEILING IS CHECKED ON EVERY ACCRUAL, never at settlement. A limit
 *      applied when the invoice is prepared is not a limit, it is a receipt.
 *   2. THE WINDOW IS THE SUBSCRIPTION'S, not the calendar month's. Keying on
 *      the wall clock would reset the cap on the 1st for a customer anchored on
 *      the 10th, letting one cycle spend two ceilings. That bug already existed
 *      in auto-purchase; `spendWindowKey` is the single answer both now use.
 *   3. THE CURRENCY IS THE ORGANIZATION'S, resolved once, never a literal. A
 *      cap typed as "100" has to mean one thing.
 *
 * Accrual is deliberately clamped rather than refused: when the last chunk of
 * usage would cross the ceiling, we bill up to the ceiling and stop there. The
 * work is already done and the model already cost us money - refusing to record
 * it would mean serving it for free, and refusing to serve the NEXT call is what
 * the gate is for.
 */
import { prisma, readPaygAccess } from "@chatcenter/shared";
import { spendWindowKey } from "../lib/period";
import { commercialCurrencyFor } from "../lib/currency";
import { emitBillingEvent } from "../lib/events";

/** No configured rate means PAYG cannot price anything, so it must not serve. */
export const NO_PAYG_RATE = "no_payg_rate";

export interface PaygState {
  /** PAYG is the configured behaviour AND a rate exists. */
  enabled: boolean;
  periodKey: string | null;
  accruedAmount: number;
  accruedUnits: number;
  ceiling: number;
  /** What is left before the cap. 0 when capped, Infinity when uncapped. */
  headroom: number;
  currency: string;
  pricePerCredit: number;
  capped: boolean;
}

interface EntityContext {
  entityId: string;
  policy: {
    limitBehavior: string;
    maxMonthlySpend: unknown;
    paygPricePerCredit: unknown;
    currency: string;
  };
  sub: { currentPeriodStart: Date | null } | null;
}

async function contextFor(tenantId: string): Promise<EntityContext | null> {
  const link = await prisma.billableEntityTenant.findUnique({
    where: { tenantId },
    include: { entity: { include: { autoPurchasePolicy: true, subscription: true } } },
  });
  const entity = link?.entity;
  if (!entity?.autoPurchasePolicy) return null;
  return {
    entityId: entity.id,
    policy: entity.autoPurchasePolicy as any,
    sub: entity.subscription ? { currentPeriodStart: entity.subscription.currentPeriodStart } : null,
  };
}

/**
 * What PAYG can still cover for this organization right now.
 *
 * Read by the AI gate, so it must be cheap and it must never throw: a failure
 * here has to look like "PAYG is not available", which falls through to the
 * ordinary exhausted-wallet block rather than opening an unmetered tap.
 */
export async function paygState(tenantId: string, now = new Date()): Promise<PaygState> {
  // Delegates to the SAME reader the AI gate uses. Re-deriving it here would
  // mean the screen could show budget the gate does not honour, or the reverse.
  const access = await readPaygAccess(tenantId, now);
  const accruedUnits =
    access.enabled && access.pricePerCredit > 0 ? access.accruedAmount / access.pricePerCredit : 0;
  return {
    enabled: access.enabled,
    periodKey: access.periodKey,
    accruedAmount: access.accruedAmount,
    accruedUnits,
    ceiling: access.ceiling,
    headroom: access.headroom,
    currency: access.currency,
    pricePerCredit: access.pricePerCredit,
    capped: access.enabled && access.headroom <= 0,
  };
}

/** True when the AI may keep working on PAYG. */
export async function paygHasHeadroom(tenantId: string, now = new Date()): Promise<boolean> {
  const s = await readPaygAccess(tenantId, now);
  return s.enabled && s.headroom > 0;
}

export interface AccrueResult {
  accrued: boolean;
  units: number;
  amount: number;
  /** Units dropped because the ceiling was reached. */
  unitsRefused: number;
  capped: boolean;
  periodKey?: string;
  reason?: string;
}

/**
 * Record usage the wallet could not cover.
 *
 * Never throws: the model call it describes has already happened, and turning a
 * bookkeeping failure into an exception at the caller would fail a request the
 * customer already received an answer to.
 */
export async function accruePaygUsage(input: {
  tenantId: string;
  units: number;
  now?: Date;
}): Promise<AccrueResult> {
  const now = input.now ?? new Date();
  const none: AccrueResult = { accrued: false, units: 0, amount: 0, unitsRefused: 0, capped: false };
  if (!(input.units > 0)) return none;

  try {
    const ctx = await contextFor(input.tenantId);
    if (!ctx || ctx.policy.limitBehavior !== "PAYG") return { ...none, reason: "payg_not_enabled" };

    const rate = ctx.policy.paygPricePerCredit != null ? Number(ctx.policy.paygPricePerCredit) : 0;
    if (!(rate > 0)) return { ...none, reason: NO_PAYG_RATE };

    const periodKey = spendWindowKey(ctx.sub, now);
    const currency = ctx.policy.currency || (await commercialCurrencyFor(ctx.entityId));
    const ceiling = ctx.policy.maxMonthlySpend != null ? Number(ctx.policy.maxMonthlySpend) : Infinity;

    // Create-or-read first, so the frozen rate and currency exist before any
    // arithmetic. The unique on (entity, period) makes a concurrent create a
    // race the database settles rather than two half-rows to reconcile later.
    const existing = await prisma.paygAccrual.upsert({
      where: { billableEntityId_periodKey: { billableEntityId: ctx.entityId, periodKey } },
      create: {
        billableEntityId: ctx.entityId,
        periodKey,
        currency,
        pricePerCredit: rate.toFixed(6),
        units: "0",
        amount: "0",
      },
      update: {},
    });

    if (existing.status !== "OPEN") {
      // The window has been billed. Usage after that belongs to the next one,
      // and silently folding it into a settled row would restate an invoice
      // the customer has already been charged for.
      return { ...none, reason: `accrual_${existing.status.toLowerCase()}`, periodKey };
    }

    // Price against the FROZEN rate, not the policy's current one: a mid-cycle
    // price change must not restate usage already consumed.
    const frozenRate = Number(existing.pricePerCredit);
    const already = Number(existing.amount);
    const headroom = ceiling === Infinity ? Infinity : Math.max(0, ceiling - already);

    if (headroom <= 0) {
      await markCapped(existing.id, existing.cappedAt, input.tenantId, already, ceiling, currency);
      return { ...none, capped: true, unitsRefused: input.units, reason: "ceiling_reached", periodKey };
    }

    const wanted = round2(input.units * frozenRate);
    const billable = headroom === Infinity ? wanted : Math.min(wanted, round2(headroom));
    // Clamped, not refused: the work is done and the model already cost us. What
    // the ceiling stops is the NEXT call, via the gate.
    const billableUnits = frozenRate > 0 ? billable / frozenRate : 0;
    const refused = Math.max(0, input.units - billableUnits);

    const updated = await prisma.paygAccrual.update({
      where: { id: existing.id },
      data: {
        units: { increment: billableUnits.toFixed(6) as any },
        amount: { increment: billable.toFixed(2) as any },
      },
    });

    const nowCapped = ceiling !== Infinity && Number(updated.amount) >= ceiling;
    if (nowCapped) {
      await markCapped(updated.id, updated.cappedAt, input.tenantId, Number(updated.amount), ceiling, currency);
    }

    return {
      accrued: true,
      units: billableUnits,
      amount: billable,
      unitsRefused: refused,
      capped: nowCapped,
      periodKey,
    };
  } catch (err: any) {
    console.warn("[billing.payg] accrual failed:", err?.message ?? err);
    return { ...none, reason: "accrual_failed" };
  }
}

/** Stamp the cap once and tell the owner once, not on every subsequent call. */
async function markCapped(
  id: string,
  alreadyCapped: Date | null,
  tenantId: string,
  accrued: number,
  ceiling: number,
  currency: string,
): Promise<void> {
  if (alreadyCapped) return;
  await prisma.paygAccrual.update({ where: { id }, data: { cappedAt: new Date() } });
  await emitBillingEvent({
    type: "credit.payg_ceiling_reached",
    tenantId,
    data: { accrued, ceiling, currency, manualPurchasePath: "/settings/billing/credits" },
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Settlement ──────────────────────────────────────────────────────────────

export interface SettleResult {
  settled: boolean;
  amount: number;
  currency?: string;
  periodKey?: string;
  invoiceId?: string;
  reason?: string;
}

/**
 * Bill a CLOSED window's accrued usage.
 *
 * Called at renewal, for the window that just ended - never for the open one.
 * Billing the current window would charge a customer mid-cycle for usage they
 * were told arrives at the end of it.
 *
 * The OPEN → SETTLING transition is a compare-and-set on status, so a retry, a
 * second scheduler tick, or a manual run cannot bill the same window twice. If
 * the charge then fails, the row goes back to OPEN and dunning owns it: leaving
 * it SETTLING would freeze the money owed in a state nothing retries.
 */
export async function settlePaygPeriod(input: {
  tenantId: string;
  entityId: string;
  periodKey: string;
  now?: Date;
}): Promise<SettleResult> {
  const { chargeFor } = await import("./invoice.service");
  const accrual = await prisma.paygAccrual.findUnique({
    where: { billableEntityId_periodKey: { billableEntityId: input.entityId, periodKey: input.periodKey } },
  });
  if (!accrual) return { settled: false, amount: 0, reason: "no_accrual" };
  if (accrual.status !== "OPEN") return { settled: false, amount: 0, reason: `already_${accrual.status.toLowerCase()}` };

  const amount = Number(accrual.amount);
  if (!(amount > 0)) {
    // Nothing was consumed on PAYG. Close it so the window is not revisited on
    // every later tick.
    await prisma.paygAccrual.update({ where: { id: accrual.id }, data: { status: "VOID", settledAt: new Date() } });
    return { settled: false, amount: 0, reason: "nothing_accrued" };
  }

  // CAS: only the caller that moves it out of OPEN gets to charge.
  const claimed = await prisma.paygAccrual.updateMany({
    where: { id: accrual.id, status: "OPEN" },
    data: { status: "SETTLING" },
  });
  if (claimed.count === 0) return { settled: false, amount, reason: "claimed_by_another" };

  try {
    const res = await chargeFor({
      entityId: input.entityId,
      tenantId: input.tenantId,
      type: "PAYG_SETTLEMENT",
      amount,
      currency: accrual.currency,
      description: `Pay-as-you-go usage, ${input.periodKey}: ${Number(accrual.units).toFixed(2)} credits`,
      // Deterministic and derived from what is being paid for, so a retry is
      // the same logical charge rather than a second bill.
      idempotencyKey: `payg:${input.entityId}:${input.periodKey}`,
    });

    if (res.outcomeUnknown) {
      // Neither settled nor safe to retry. Left SETTLING deliberately, with the
      // reconciliation event that owns it - the one case where OPEN would be
      // wrong, because a charge may in fact have landed.
      await emitBillingEvent({
        type: "payment.reconciliation_required",
        tenantId: input.tenantId,
        data: { invoiceId: res.invoiceId, context: "payg_settlement", amount, periodKey: input.periodKey },
      });
      return { settled: false, amount, currency: accrual.currency, periodKey: input.periodKey, invoiceId: res.invoiceId, reason: "outcome_unknown" };
    }

    if (!res.success) {
      await prisma.paygAccrual.updateMany({ where: { id: accrual.id, status: "SETTLING" }, data: { status: "OPEN" } });
      await emitBillingEvent({
        type: "payment.failed",
        tenantId: input.tenantId,
        data: { context: "payg_settlement", amount, currency: accrual.currency, periodKey: input.periodKey },
      });
      return { settled: false, amount, currency: accrual.currency, periodKey: input.periodKey, reason: res.failureCode ?? "charge_failed" };
    }

    // chargeFor does not hand back a charge id, and the settled row should point
    // at the money. The idempotency key is unique, so it resolves exactly one.
    const charge = await prisma.charge
      .findUnique({ where: { idempotencyKey: `payg:${input.entityId}:${input.periodKey}` }, select: { id: true } })
      .catch(() => null);

    await prisma.paygAccrual.update({
      where: { id: accrual.id },
      data: { status: "SETTLED", settledAt: new Date(), settledChargeId: charge?.id ?? null },
    });
    return { settled: true, amount, currency: accrual.currency, periodKey: input.periodKey, invoiceId: res.invoiceId };
  } catch (err: any) {
    await prisma.paygAccrual.updateMany({ where: { id: accrual.id, status: "SETTLING" }, data: { status: "OPEN" } });
    console.warn("[billing.payg] settlement failed:", err?.message ?? err);
    return { settled: false, amount, periodKey: input.periodKey, reason: "settlement_error" };
  }
}

/**
 * Settle every window that has closed and still owes money.
 *
 * Driven by the scheduler rather than by renewal alone: a subscription that
 * fails to renew must still be billed for what it already consumed.
 */
export async function settleDuePaygAccruals(now = new Date()): Promise<{ settled: number; amount: number }> {
  const open = await prisma.paygAccrual.findMany({
    where: { status: "OPEN" },
    include: { entity: { include: { subscription: true, tenants: { take: 1 } } } },
    take: 200,
  });

  let settled = 0;
  let amount = 0;
  for (const row of open) {
    const currentKey = spendWindowKey(
      row.entity.subscription ? { currentPeriodStart: row.entity.subscription.currentPeriodStart } : null,
      now,
    );
    // Only CLOSED windows. The open one is still accruing.
    if (row.periodKey === currentKey) continue;
    const tenantId = row.entity.tenants[0]?.tenantId;
    if (!tenantId) continue;

    const res = await settlePaygPeriod({ tenantId, entityId: row.billableEntityId, periodKey: row.periodKey, now });
    if (res.settled) {
      settled++;
      amount += res.amount;
    }
  }
  return { settled, amount };
}
