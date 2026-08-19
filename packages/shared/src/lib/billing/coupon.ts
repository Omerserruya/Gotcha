/**
 * Coupon arithmetic.
 *
 * A coupon is a discount on a price, never a replacement for it. Everything
 * here therefore returns BOTH figures - the list price and what is actually
 * payable - because every surface that shows money has to show the pair: the
 * charge takes the net, the billing page shows the list struck through with the
 * saving beside it, and the receipt has to reconcile against both.
 *
 * Pure functions on purpose: no Prisma, no clock. The billing service loads the
 * assignment and passes it in, which keeps this testable to the agora and stops
 * the rounding rule from being reimplemented per call site.
 *
 * ── Rounding ──
 *
 * Percentages are computed in MINOR units and rounded half-up, so 20% off
 * 149.99 is 30.00 (not 29.998 rendered three different ways in three places).
 * The discount is what gets rounded; the net is list minus discount, so the two
 * always add back up to the list exactly.
 */
import { money, toDecimalString, toMinor, type Money } from "./money";

export type CouponDiscountKind = "PERCENT" | "FIXED";

export interface CouponTerms {
  code: string;
  discountType: CouponDiscountKind;
  /** PERCENT: 1-100. */
  percentOff?: number | null;
  /** FIXED: amount in `currency`. */
  amountOff?: unknown;
  currency?: string | null;
}

export interface DiscountBreakdown {
  /** The contracted price, before any coupon. */
  list: Money;
  /** What the coupon takes off. Zero when nothing applied. */
  discount: Money;
  /** What is actually payable: list - discount, never below zero. */
  net: Money;
  /** Null when no coupon applied, or when one was skipped (see `skipped`). */
  coupon: { code: string; label: string } | null;
  /**
   * Why a present coupon did not apply. `null` when it did, or when there was
   * none to begin with. Surfaced rather than swallowed: a coupon that silently
   * stops discounting is the failure mode worth being loud about.
   */
  skipped: "currency_mismatch" | "invalid_terms" | null;
}

/**
 * Apply one coupon's terms to a price.
 *
 * A FIXED coupon in a different currency than the charge is REFUSED, not
 * converted. Converting would make the discount drift with the FX rate every
 * month and quietly change what the customer agreed to; refusing keeps the
 * charge honest and surfaces as `skipped` so an operator can fix the coupon.
 */
export function applyCouponToPrice(
  listPrice: unknown,
  currency: string,
  terms: CouponTerms | null | undefined,
): DiscountBreakdown {
  const list = money(listPrice, currency as any);
  const none = (skipped: DiscountBreakdown["skipped"]): DiscountBreakdown => ({
    list,
    discount: money(0, currency as any),
    net: list,
    coupon: null,
    skipped,
  });

  if (!terms) return none(null);
  if (list.minor <= 0) return none(null);

  let discountMinor: number;
  if (terms.discountType === "PERCENT") {
    const pct = Number(terms.percentOff ?? 0);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return none("invalid_terms");
    // Half-up on the minor unit, so the saving is a real payable figure.
    discountMinor = Math.round((list.minor * pct) / 100);
  } else {
    if (!terms.currency || terms.currency.toUpperCase() !== currency.toUpperCase()) {
      return none("currency_mismatch");
    }
    const off = toMinor(terms.amountOff, currency as any);
    if (!Number.isFinite(off) || off <= 0) return none("invalid_terms");
    discountMinor = off;
  }

  // A discount larger than the price zeroes the charge; it never turns into a
  // credit the customer could withdraw.
  discountMinor = Math.min(discountMinor, list.minor);
  if (discountMinor <= 0) return none(null);

  return {
    list,
    discount: { minor: discountMinor, currency: list.currency },
    net: { minor: list.minor - discountMinor, currency: list.currency },
    coupon: { code: terms.code, label: couponLabel(terms) },
    skipped: null,
  };
}

/** "20% off" / "50.00 ILS off" - short enough for a badge, exact enough for a receipt. */
export function couponLabel(terms: CouponTerms): string {
  if (terms.discountType === "PERCENT") return `${Number(terms.percentOff ?? 0)}% off`;
  const amount = toDecimalString(money(terms.amountOff, (terms.currency ?? "USD") as any));
  return `${amount} ${String(terms.currency ?? "").toUpperCase()} off`;
}

/**
 * Is this assignment in force for a charge happening `at`?
 *
 * Inclusive of the start instant and exclusive of the end, so a coupon written
 * "until 2027-01-01" does not discount a charge on that date.
 */
export function assignmentIsLive(
  assignment: { status: string; startsAt: Date | string; endsAt?: Date | string | null },
  at: Date,
): boolean {
  if (assignment.status !== "ACTIVE") return false;
  if (new Date(assignment.startsAt).getTime() > at.getTime()) return false;
  if (assignment.endsAt && new Date(assignment.endsAt).getTime() <= at.getTime()) return false;
  return true;
}

/** Decimal strings for persistence, in the price's own currency. */
export function breakdownToDecimals(b: DiscountBreakdown): {
  list: string;
  discount: string;
  net: string;
} {
  return {
    list: toDecimalString(b.list),
    discount: toDecimalString(b.discount),
    net: toDecimalString(b.net),
  };
}
