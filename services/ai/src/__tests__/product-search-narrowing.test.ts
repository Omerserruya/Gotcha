/**
 * The search has to answer the question that was asked.
 *
 * Every fixture here is the REAL Urban Supply catalogue, read from the store on
 * 2026-08-26, because the bug these cover was not hypothetical: a shopper said
 * "600 דולר", and four turns running got boards at 949.95, 885.95 and 749.95 -
 * the first three rows of the catalogue in Shopify's own order - while the one
 * board priced at 600.00 was never shown. Two of the three were not even
 * buyable.
 */

import { describe, it, expect } from "vitest";
import {
  priceBounds,
  lowestPrice,
  hasBuyableVariant,
  narrowProducts,
} from "../services/connectors/shopify.adapter";

/** The store, in the order Shopify returns it. */
const CATALOG = [
  p("Gift Card", 10.0, false),
  p("The Inventory Not Tracked Snowboard", 949.95, true),
  p("The Minimal Snowboard", 885.95, true),
  p("The Hidden Snowboard", 749.95, true),
  p("The Compare at Price Snowboard", 785.95, true),
  p("The Out of Stock Snowboard", 885.95, false),
  p("The Collection Snowboard: Hydrogen", 600.0, true),
  p("The Videographer Snowboard", 885.95, true),
  p("The Complete Snowboard", 699.95, true),
  p("Selling Plans Ski Wax", 24.95, true),
  p("The Multi-location Snowboard", 729.95, true),
  p("The 3p Fulfilled Snowboard", 2629.95, true),
  p("The Multi-managed Snowboard", 629.95, true),
  p("The Collection Snowboard: Oxygen", 1025.0, true),
  p("The Collection Snowboard: Liquid", 749.95, true),
];

function p(title: string, price: number, available: boolean, extraVariants: any[] = []) {
  return {
    id: title.replace(/\W+/g, "_"),
    title,
    product_type: title.includes("Wax") ? "Wax" : title.includes("Gift") ? "Gift" : "Snowboard",
    variants: [{ id: `${title}-v1`, price: String(price), available }, ...extraVariants],
  };
}

const titles = (list: any[]) => list.map((x) => x.title);

describe("price bounds", () => {
  it("reads either bound, from a number or a numeric string", () => {
    expect(priceBounds({ price_max: 600 })).toEqual({ max: 600 });
    expect(priceBounds({ price_min: "100" })).toEqual({ min: 100 });
    expect(priceBounds({ price_min: 100, price_max: 600 })).toEqual({ min: 100, max: 600 });
  });

  it("is null when there is nothing usable to bound by", () => {
    expect(priceBounds({})).toBeNull();
    expect(priceBounds({ price_max: "about six hundred" })).toBeNull();
    expect(priceBounds({ price_max: -5 })).toBeNull();
  });
});

describe("the price a budget is judged against", () => {
  it("is the LOWEST variant, not whichever one came first", () => {
    const board = p("Two Sizes", 900, true, [{ id: "v2", price: "550.00", available: true }]);
    expect(lowestPrice(board, true)).toBe(550);
  });

  it("ignores variants nobody can buy when stock is being enforced", () => {
    const board = p("Cheap One Sold Out", 900, true, [{ id: "v2", price: "550.00", available: false }]);
    // 550 exists but cannot be bought, so a 600 budget must not match on it.
    expect(lowestPrice(board, true)).toBe(900);
    expect(lowestPrice(board, false)).toBe(550);
  });

  it("is null when the product carries no readable price", () => {
    expect(lowestPrice({ variants: [{ price: null }] }, true)).toBeNull();
    expect(lowestPrice({}, true)).toBeNull();
  });
});

describe("buyability", () => {
  it("needs at least one available variant", () => {
    expect(hasBuyableVariant(p("Sold Out", 100, false))).toBe(false);
    expect(hasBuyableVariant(p("In Stock", 100, true))).toBe(true);
  });

  it("treats an unknown verdict as available, never as gone", () => {
    // Shopify not telling us is not Shopify saying no. Hiding a product on a
    // missing field would empty a catalogue over a mapping gap.
    expect(hasBuyableVariant({ variants: [{ price: "10" }] })).toBe(true);
  });
});

describe("narrowing the real catalogue", () => {
  it("finds the board that fits a 600 budget instead of the first three rows", () => {
    const out = narrowProducts(CATALOG, { max: 600 }, true);
    // The wax is under 600 too and correctly survives a PRICE filter - keeping
    // the result to snowboards is the search term's job, not this function's.
    expect(titles(out)).toEqual(["The Collection Snowboard: Hydrogen", "Selling Plans Ski Wax"]);
    // The three the shopper actually got are all gone.
    expect(titles(out)).not.toContain("The Inventory Not Tracked Snowboard");
    expect(titles(out)).not.toContain("The Minimal Snowboard");
    expect(titles(out)).not.toContain("The Hidden Snowboard");
  });

  it("treats the bound as inclusive - 600.00 fits a 600 budget", () => {
    const out = narrowProducts([p("Exactly", 600, true)], { max: 600 }, true);
    expect(out).toHaveLength(1);
  });

  it("drops what nobody can buy", () => {
    const out = narrowProducts(CATALOG, null, true);
    expect(titles(out)).not.toContain("The Out of Stock Snowboard");
    expect(titles(out)).not.toContain("Gift Card");
    expect(out).toHaveLength(13);
  });

  it("keeps Shopify's relevance order rather than re-sorting by price", () => {
    // Re-sorting here would turn "the best match under 800" into "the cheapest
    // thing in the store", which is a different answer to a different question.
    const out = narrowProducts(CATALOG, { max: 800 }, true);
    expect(titles(out)).toEqual([
      "The Hidden Snowboard",
      "The Compare at Price Snowboard",
      "The Collection Snowboard: Hydrogen",
      "The Complete Snowboard",
      "Selling Plans Ski Wax",
      "The Multi-location Snowboard",
      "The Multi-managed Snowboard",
      "The Collection Snowboard: Liquid",
    ]);
  });

  it("applies both bounds together", () => {
    const out = narrowProducts(CATALOG, { min: 700, max: 760 }, true);
    expect(titles(out)).toEqual([
      "The Hidden Snowboard",
      "The Multi-location Snowboard",
      "The Collection Snowboard: Liquid",
    ]);
  });

  it("does not exclude an unpriced product on a bound it cannot breach", () => {
    const unpriced = { id: "x", title: "Unpriced", variants: [{ price: null, available: true }] };
    expect(narrowProducts([unpriced], { max: 10 }, true)).toHaveLength(1);
  });

  it("returns the catalogue untouched when nothing was asked of it", () => {
    expect(narrowProducts(CATALOG, null, false)).toHaveLength(CATALOG.length);
  });

  it("returns empty rather than something over budget", () => {
    // An honest nothing. The prose fallback - showing three over-budget boards
    // and adding "none of these fit your budget" - is what this replaces.
    expect(narrowProducts(CATALOG, { max: 20 }, true)).toEqual([]);
  });
});
