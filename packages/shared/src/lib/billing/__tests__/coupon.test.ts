import { describe, it, expect } from "vitest";
import {
  applyCouponToPrice,
  couponLabel,
  assignmentIsLive,
  breakdownToDecimals,
  type CouponTerms,
} from "../coupon";

/**
 * A coupon changes what a customer PAYS. These tests pin the two properties
 * every surface depends on:
 *
 *   • list - discount = net, exactly, with no rounding drift. The billing page
 *     shows all three; if they did not reconcile, the customer would be shown
 *     arithmetic that does not add up.
 *   • a coupon that cannot legitimately apply is REFUSED rather than
 *     approximated - the failure mode being guarded against is a discount that
 *     quietly changes size, which is worse than one that visibly does nothing.
 */

const PCT20: CouponTerms = { code: "LAUNCH20", discountType: "PERCENT", percentOff: 20 };
const FIXED50_ILS: CouponTerms = { code: "FIFTY", discountType: "FIXED", amountOff: "50.00", currency: "ILS" };

describe("percentage discounts", () => {
  it("takes the percentage off and the parts reconcile", () => {
    const b = applyCouponToPrice("149.00", "ILS", PCT20);
    expect(breakdownToDecimals(b)).toEqual({ list: "149.00", discount: "29.80", net: "119.20" });
    expect(b.list.minor).toBe(b.discount.minor + b.net.minor);
    expect(b.coupon).toEqual({ code: "LAUNCH20", label: "20% off" });
  });

  it("rounds half-up on the minor unit rather than leaving fractional agorot", () => {
    // 20% of 149.99 = 29.998 → 30.00, and the net absorbs the rounding.
    const b = applyCouponToPrice("149.99", "ILS", PCT20);
    expect(breakdownToDecimals(b)).toEqual({ list: "149.99", discount: "30.00", net: "119.99" });
    expect(b.list.minor).toBe(b.discount.minor + b.net.minor);
  });

  it("applies to any currency, because a percentage has none of its own", () => {
    const b = applyCouponToPrice("100.00", "USD", PCT20);
    expect(breakdownToDecimals(b).net).toBe("80.00");
    expect(b.skipped).toBeNull();
  });

  it("refuses a nonsense percentage instead of guessing", () => {
    for (const pct of [0, -5, 101]) {
      const b = applyCouponToPrice("100.00", "ILS", { ...PCT20, percentOff: pct });
      expect(b.skipped).toBe("invalid_terms");
      expect(breakdownToDecimals(b).net).toBe("100.00");
    }
  });
});

describe("fixed-amount discounts", () => {
  it("takes the amount off when the currency matches", () => {
    const b = applyCouponToPrice("149.00", "ILS", FIXED50_ILS);
    expect(breakdownToDecimals(b)).toEqual({ list: "149.00", discount: "50.00", net: "99.00" });
    expect(couponLabel(FIXED50_ILS)).toBe("50.00 ILS off");
  });

  // The important one: converting would make the discount drift with the FX
  // rate every month, silently changing what the customer agreed to.
  it("REFUSES a different currency rather than converting it", () => {
    const b = applyCouponToPrice("100.00", "USD", FIXED50_ILS);
    expect(b.skipped).toBe("currency_mismatch");
    expect(breakdownToDecimals(b).net).toBe("100.00");
    expect(b.coupon).toBeNull();
  });

  it("never turns a discount bigger than the price into a credit", () => {
    const b = applyCouponToPrice("30.00", "ILS", FIXED50_ILS);
    expect(breakdownToDecimals(b)).toEqual({ list: "30.00", discount: "30.00", net: "0.00" });
    expect(b.net.minor).toBe(0);
  });
});

describe("no coupon, or nothing to discount", () => {
  it("passes the price through untouched", () => {
    const b = applyCouponToPrice("149.00", "ILS", null);
    expect(breakdownToDecimals(b)).toEqual({ list: "149.00", discount: "0.00", net: "149.00" });
    expect(b.coupon).toBeNull();
    expect(b.skipped).toBeNull();
  });

  it("leaves a zero price alone (sales-only and grandfathered plans)", () => {
    const b = applyCouponToPrice("0.00", "ILS", PCT20);
    expect(breakdownToDecimals(b).net).toBe("0.00");
    expect(b.coupon).toBeNull();
  });
});

describe("the assignment window is the recurrence", () => {
  const start = new Date("2026-01-01T00:00:00Z");
  const end = new Date("2027-01-01T00:00:00Z");
  const live = { status: "ACTIVE", startsAt: start, endsAt: end };

  it("discounts every period inside the window - twelve monthly charges, one row", () => {
    for (let m = 0; m < 12; m += 1) {
      const charge = new Date(Date.UTC(2026, m, 1));
      expect(assignmentIsLive(live, charge)).toBe(true);
    }
  });

  it("stops at the end date, exclusive", () => {
    expect(assignmentIsLive(live, new Date("2026-12-31T23:59:59Z"))).toBe(true);
    expect(assignmentIsLive(live, end)).toBe(false);
    expect(assignmentIsLive(live, new Date("2027-02-01T00:00:00Z"))).toBe(false);
  });

  it("is not live before it starts", () => {
    expect(assignmentIsLive(live, new Date("2025-12-31T00:00:00Z"))).toBe(false);
  });

  it("an open-ended assignment keeps applying", () => {
    expect(assignmentIsLive({ status: "ACTIVE", startsAt: start, endsAt: null }, new Date("2030-06-01T00:00:00Z"))).toBe(true);
  });

  it("a revoked or expired assignment applies to nothing", () => {
    expect(assignmentIsLive({ ...live, status: "REVOKED" }, new Date("2026-06-01T00:00:00Z"))).toBe(false);
    expect(assignmentIsLive({ ...live, status: "EXPIRED" }, new Date("2026-06-01T00:00:00Z"))).toBe(false);
  });
});
