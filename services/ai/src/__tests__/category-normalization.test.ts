import { describe, it, expect } from "vitest";
import { normalizeCategory } from "../services/historical-intelligence/knowledge-extraction.stage";

/**
 * Measured over 65 real items from one import: 42 carried a category that was
 * not in the enum, and not one of them was nonsense. The model paraphrases the
 * list instead of copying it. Sending every near-miss to OTHER discarded a
 * correct classification over wording, which is how 263 of 266 candidates ended
 * up ungrouped.
 */
describe("normalizeCategory", () => {
  it("passes through the canonical values untouched", () => {
    for (const c of ["ORDERING_AND_PAYMENT", "BOOKING_AND_SCHEDULING", "OTHER"]) {
      expect(normalizeCategory(c)).toBe(c);
    }
  });

  it("maps the near-misses actually observed in production", () => {
    const observed: Array<[string, string]> = [
      ["PAYMENT", "ORDERING_AND_PAYMENT"],
      ["PAYMENT_METHODS", "ORDERING_AND_PAYMENT"],
      ["BOOKINGS_AND_APPOINTMENTS", "BOOKING_AND_SCHEDULING"],
      ["OPENING_HOURS", "LOCATION_AND_HOURS"],
      ["PRODUCT", "PRODUCT_AND_SPECS"],
      ["PRODUCT_FACT", "PRODUCT_AND_SPECS"],
    ];
    for (const [given, expected] of observed) {
      expect(normalizeCategory(given), given).toBe(expected);
    }
  });

  it("sends a genuinely new name to OTHER rather than guessing", () => {
    for (const odd of ["LOGISTICS", "CAPACITY", "STAFFING", "CATERING_MENU"]) {
      expect(normalizeCategory(odd), odd).toBe("OTHER");
    }
  });

  it("refuses to guess when a name could belong to two categories", () => {
    // "PRICING_AND_PAYMENT" shares a word with both PRICING_AND_DISCOUNTS and
    // ORDERING_AND_PAYMENT. A wrong group is worse than an honest ungrouped one.
    expect(normalizeCategory("PRICING_AND_PAYMENT")).toBe("OTHER");
  });

  it("ignores case and filler words", () => {
    expect(normalizeCategory("shipping and delivery")).toBe("SHIPPING_AND_DELIVERY");
    expect(normalizeCategory("Returns")).toBe("RETURNS_AND_CANCELLATION");
  });

  it("handles missing, empty and non-string input", () => {
    for (const bad of [undefined, null, "", "   ", 42, {}]) {
      expect(normalizeCategory(bad as unknown)).toBe("OTHER");
    }
  });

  it("does not let a scope value masquerade as a category", () => {
    // HOW_WE_WORK and PRODUCT_FACT are scope values the model puts here. The
    // first has no canonical counterpart and must not be invented into one.
    expect(normalizeCategory("HOW_WE_WORK")).toBe("OTHER");
  });
});
