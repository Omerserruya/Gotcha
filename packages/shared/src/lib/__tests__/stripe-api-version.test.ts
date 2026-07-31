import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  stripeApiVersion,
  stripeVersionHeader,
  reportStripeApiVersion,
  STRIPE_API_VERSION_REVIEW_BY,
  __resetStripeApiVersionCache,
} from "../stripe-api-version";

beforeEach(() => __resetStripeApiVersionCache());
afterEach(() => vi.restoreAllMocks());

describe("the version is pinned in code, not inherited from the dashboard", () => {
  it("defaults to an established MAJOR, not the brand-new one", () => {
    // Dahlia shipped 2026-07-29 — two days before this was written. Majors are
    // where Stripe puts breaking changes; inheriting one by accident on the
    // path that refunds a merchant's customers is not a sane default.
    expect(stripeApiVersion({} as NodeJS.ProcessEnv)).toBe("2026-02-25.clover");
  });

  it("always produces a Stripe-Version header - the whole point", () => {
    const h = stripeVersionHeader({} as any);
    expect(h).toEqual({ "Stripe-Version": "2026-02-25.clover" });
    // Absent this header Stripe uses the account's dashboard default.
    expect(Object.keys(h)).toContain("Stripe-Version");
  });

  it("accepts a validated override", () => {
    expect(stripeApiVersion({ STRIPE_API_VERSION: "2026-07-29.dahlia" } as any))
      .toBe("2026-07-29.dahlia");
    __resetStripeApiVersionCache();
    // Bare dated versions (no release name) are also legal Stripe versions.
    expect(stripeApiVersion({ STRIPE_API_VERSION: "2025-08-27" } as any)).toBe("2025-08-27");
  });

  it("THROWS on a malformed override instead of silently reverting", () => {
    // A silent fallback would hand control back to the account default, which
    // is precisely the condition this module removes.
    for (const bad of ["clover", "2026-02", "26-02-25", "2026-02-25.Clover", "latest"]) {
      __resetStripeApiVersionCache();
      expect(() => stripeApiVersion({ STRIPE_API_VERSION: bad } as any))
        .toThrow(/not a valid Stripe API version/);
    }
  });

  it("carries a review date - Stripe versions never expire, so this is advisory", () => {
    expect(STRIPE_API_VERSION_REVIEW_BY).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(STRIPE_API_VERSION_REVIEW_BY) > new Date("2026-07-31")).toBe(true);
  });

  it("reports the pin at startup, and says it is not the account default", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(reportStripeApiVersion({} as any)).toBe("2026-02-25.clover");
    const msg = String(log.mock.calls[0]?.[0]);
    expect(msg).toContain("2026-02-25.clover");
    expect(msg).toContain("not the account default");
  });
});
