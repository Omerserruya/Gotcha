/**
 * The exchange rate money is charged at.
 *
 * GOTCHA sells in USD and charges in ILS. Something has to decide the number in
 * between, and that decision is a commercial one - so it is made by a person,
 * recorded with who made it and who approved it, and frozen onto every payment
 * it touches.
 *
 * This is deliberately NOT `getUsdIlsRate` from the shared billing lib. That one
 * fetches from an external source on demand and silently substitutes a hardcoded
 * 3.7 when the fetch fails. For showing an approximate price that is fine. For
 * deciding what to charge a customer it is not: a network blip would quietly
 * change the amount taken from their card, and nobody could later say which rate
 * applied or why. Display keeps that path; payments use this one.
 *
 * Nothing here reaches the network. If no ACTIVE rate exists, charging fails
 * closed - an unpriced charge is worse than a blocked one.
 */
import { prisma } from "@chatcenter/shared";
import { Prisma } from "@prisma/client";
import type { BillingExchangeRate } from "@prisma/client";

export const DEFAULT_BASE = "USD";
export const DEFAULT_QUOTE = "ILS";

/** Two decimals, half-up. Stated explicitly because rounding money is a policy. */
export const ROUNDING_MODE = "HALF_UP" as const;
const ROUND = Prisma.Decimal.ROUND_HALF_UP;
const SCALE = 2;

export class ExchangeRateUnavailable extends Error {
  constructor(readonly code: string, detail?: string) {
    super(`[billing] exchange rate unavailable: ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "ExchangeRateUnavailable";
  }
}

export class ExchangeRateRefused extends Error {
  constructor(readonly code: string, detail?: string) {
    super(`[billing] exchange rate refused: ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "ExchangeRateRefused";
  }
}

/**
 * The rate in force right now, or a typed failure.
 *
 * Requires status ACTIVE and `now` inside [activeFrom, activeUntil). A rate that
 * has not started yet, or one whose window closed, is not "close enough" - it is
 * simply not the rate, and using it would charge at a figure nobody approved.
 */
export async function activeRate(
  opts: { base?: string; quote?: string; now?: Date } = {},
): Promise<BillingExchangeRate> {
  const base = (opts.base ?? DEFAULT_BASE).toUpperCase();
  const quote = (opts.quote ?? DEFAULT_QUOTE).toUpperCase();
  const now = opts.now ?? new Date();

  const rate = await prisma.billingExchangeRate.findFirst({
    where: {
      baseCurrency: base,
      quoteCurrency: quote,
      status: "ACTIVE",
      activeFrom: { lte: now },
      OR: [{ activeUntil: null }, { activeUntil: { gt: now } }],
    },
    orderBy: { activeFrom: "desc" },
  });

  if (!rate) throw new ExchangeRateUnavailable("no_active_rate", `${base}->${quote}`);
  if (!rate.approvedBy || !rate.approvedAt) {
    // Belt and braces. Approval is what makes a rate chargeable, so an ACTIVE
    // row without it means someone bypassed `approveRate` with raw SQL.
    throw new ExchangeRateUnavailable("active_rate_not_approved", rate.id);
  }
  if (new Prisma.Decimal(rate.rate).lte(0)) {
    throw new ExchangeRateUnavailable("non_positive_rate", rate.id);
  }
  return rate;
}

/** Whether charging is currently possible at all. Used to gate the UI. */
export async function chargingRateConfigured(
  opts: { base?: string; quote?: string; now?: Date } = {},
): Promise<boolean> {
  try {
    await activeRate(opts);
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert with exact decimal arithmetic.
 *
 * Never binary floating point: 0.1 + 0.2 is not 0.3, and the place that
 * difference shows up is a customer's statement.
 */
export function convert(amount: Prisma.Decimal.Value, rate: Prisma.Decimal.Value): Prisma.Decimal {
  return new Prisma.Decimal(amount).mul(new Prisma.Decimal(rate)).toDecimalPlaces(SCALE, ROUND);
}

/**
 * Propose a rate. Created as DRAFT - proposing does not make it chargeable.
 *
 * The version is allocated by the database, so two Sysadmins proposing at once
 * collide on the unique index rather than both claiming the same version.
 */
export async function proposeRate(input: {
  rate: string | number;
  base?: string;
  quote?: string;
  activeFrom?: Date;
  activeUntil?: Date | null;
  source?: string;
  createdBy: string;
}): Promise<BillingExchangeRate> {
  const base = (input.base ?? DEFAULT_BASE).toUpperCase();
  const quote = (input.quote ?? DEFAULT_QUOTE).toUpperCase();

  const value = new Prisma.Decimal(input.rate);
  if (!value.isFinite() || value.lte(0)) throw new ExchangeRateRefused("rate_must_be_positive");
  // A rate outside this band is a typo - a decimal point in the wrong place, or
  // an inverted pair. Charging on it would be catastrophic in one direction and
  // free in the other.
  if (value.gte(1000)) throw new ExchangeRateRefused("rate_implausible", value.toString());
  if (base === quote) throw new ExchangeRateRefused("identical_currencies");

  const activeFrom = input.activeFrom ?? new Date();
  if (input.activeUntil && input.activeUntil <= activeFrom) {
    throw new ExchangeRateRefused("active_until_before_active_from");
  }

  for (let tries = 0; tries < 5; tries += 1) {
    const last = await prisma.billingExchangeRate.findFirst({
      where: { baseCurrency: base, quoteCurrency: quote },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    try {
      return await prisma.billingExchangeRate.create({
        data: {
          baseCurrency: base,
          quoteCurrency: quote,
          rate: value,
          source: input.source ?? "MANUAL_PLATFORM_RATE",
          version: (last?.version ?? 0) + 1,
          activeFrom,
          activeUntil: input.activeUntil ?? null,
          status: "DRAFT",
          createdBy: input.createdBy,
        },
      });
    } catch (err: any) {
      if (err?.code !== "P2002") throw err;
    }
  }
  throw new ExchangeRateRefused("version_allocation_contended");
}

/**
 * Approve a draft and make it the active rate.
 *
 * Retires the previous one in the same transaction. The partial unique index
 * means the database refuses two ACTIVE rates for a pair, so a race here fails
 * loudly rather than leaving the charge amount to whichever row a query happened
 * to return first.
 */
export async function approveRate(input: {
  id: string;
  approvedBy: string;
  now?: Date;
}): Promise<BillingExchangeRate> {
  const now = input.now ?? new Date();

  return prisma.$transaction(async (tx) => {
    const draft = await tx.billingExchangeRate.findUnique({ where: { id: input.id } });
    if (!draft) throw new ExchangeRateRefused("rate_not_found");
    if (draft.status === "ACTIVE") return draft;
    if (draft.status === "RETIRED") throw new ExchangeRateRefused("rate_retired");

    // Separation of duties: the person who typed the number is not the person
    // who makes it chargeable.
    if (draft.createdBy && draft.createdBy === input.approvedBy) {
      throw new ExchangeRateRefused("approver_must_differ_from_creator");
    }

    await tx.billingExchangeRate.updateMany({
      where: {
        baseCurrency: draft.baseCurrency,
        quoteCurrency: draft.quoteCurrency,
        status: "ACTIVE",
      },
      data: { status: "RETIRED", activeUntil: now },
    });

    return tx.billingExchangeRate.update({
      where: { id: draft.id },
      data: {
        status: "ACTIVE",
        approvedBy: input.approvedBy,
        approvedAt: now,
        activeFrom: draft.activeFrom < now ? draft.activeFrom : draft.activeFrom,
      },
    });
  });
}

/**
 * Retire the active rate without replacing it.
 *
 * Leaves the platform unable to charge, which is the point: it is the lever for
 * "stop taking money at this rate" when the number turns out to be wrong.
 */
export async function retireRate(input: { id: string; actor: string; now?: Date }): Promise<BillingExchangeRate> {
  const now = input.now ?? new Date();
  const rate = await prisma.billingExchangeRate.findUnique({ where: { id: input.id } });
  if (!rate) throw new ExchangeRateRefused("rate_not_found");
  return prisma.billingExchangeRate.update({
    where: { id: rate.id },
    data: { status: "RETIRED", activeUntil: rate.activeUntil ?? now },
  });
}

/** History for the Sysadmin surface. Already-charged quotes reference these by id. */
export async function rateHistory(opts: { base?: string; quote?: string; limit?: number } = {}) {
  return prisma.billingExchangeRate.findMany({
    where: {
      baseCurrency: (opts.base ?? DEFAULT_BASE).toUpperCase(),
      quoteCurrency: (opts.quote ?? DEFAULT_QUOTE).toUpperCase(),
    },
    orderBy: { version: "desc" },
    take: opts.limit ?? 50,
  });
}
