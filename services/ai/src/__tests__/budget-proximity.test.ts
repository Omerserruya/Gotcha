import { describe, it, expect } from "vitest";
import { sortProducts, narrowProducts, priceBounds } from "../services/connectors/shopify.adapter";

/**
 * Live on Urban Supply: a shopper asked for a snowboard around 600 and was
 * offered 949.95 and 885.95, while a 629.95 sat twelfth in the relevance list
 * and was never seen. Filtering by budget was the first bug; WHICH product gets
 * offered when you must go above it is a separate one, and only this half is
 * about ordering.
 */
const P = (title: string, price: number, available = true) => ({
  title,
  variants: [{ price: String(price), available }],
});

const CATALOG = [
  P("Inventory Not Tracked", 949.95),
  P("Minimal", 885.95),
  P("Hidden", 749.95),
  P("Compare at Price", 785.95),
  P("Hydrogen", 600),
  P("Complete", 699.95),
  P("Multi-location", 729.95),
  P("3p Fulfilled", 2629.95),
  P("Multi-managed", 629.95),
];

describe("sortProducts", () => {
  it("leaves relevance order alone by default", () => {
    // Re-sorting inside a budget would turn "best match under 600" into
    // "cheapest thing in the store". Default must not touch the order.
    expect(sortProducts(CATALOG, undefined, true).map((p) => p.title)).toEqual(CATALOG.map((p) => p.title));
    expect(sortProducts(CATALOG, "relevance", true).map((p) => p.title)).toEqual(CATALOG.map((p) => p.title));
  });

  it("puts the nearest price first when asked for above-budget alternatives", () => {
    const aboveBudget = narrowProducts(CATALOG, priceBounds({ price_min: 600 }), true);
    const ordered = sortProducts(aboveBudget, "price_asc", true).map((p) => p.title);
    // The whole point: 629.95 must be offered before 949.95.
    expect(ordered[0]).toBe("Hydrogen");
    expect(ordered[1]).toBe("Multi-managed");
    expect(ordered.indexOf("Multi-managed")).toBeLessThan(ordered.indexOf("Inventory Not Tracked"));
    expect(ordered[ordered.length - 1]).toBe("3p Fulfilled");
  });

  it("does not mutate the list it was given", () => {
    const before = CATALOG.map((p) => p.title);
    sortProducts(CATALOG, "price_asc", true);
    expect(CATALOG.map((p) => p.title)).toEqual(before);
  });

  it("sorts an unpriced product last rather than dropping it", () => {
    const withUnpriced = [{ title: "No price", variants: [{ price: null, available: true }] }, P("Cheap", 100)];
    const ordered = sortProducts(withUnpriced, "price_asc", true).map((p) => p.title);
    expect(ordered).toEqual(["Cheap", "No price"]);
  });

  it("judges by the cheapest BUYABLE variant", () => {
    // A 500 variant that is sold out must not make the product rank as 500.
    const multi = {
      title: "Two sizes",
      variants: [{ price: "500", available: false }, { price: "900", available: true }],
    };
    const ordered = sortProducts([multi, P("Mid", 700)], "price_asc", true).map((p) => p.title);
    expect(ordered).toEqual(["Mid", "Two sizes"]);
  });
});

describe("the budget filter itself still holds", () => {
  it("keeps only what fits under price_max", () => {
    const kept = narrowProducts(CATALOG, priceBounds({ price_max: 600 }), true).map((p) => p.title);
    expect(kept).toEqual(["Hydrogen"]);
  });
});
