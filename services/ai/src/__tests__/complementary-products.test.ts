/**
 * Cross-sell: what goes WITH the thing the customer chose.
 *
 * The rules were settled against the live Urban Supply store, and two of them
 * only exist because the store contradicted the obvious design:
 *
 *  - every collection the snowboards belong to contains ONLY snowboards, so
 *    "same collection, different type" finds nothing there while the store does
 *    stock wax. Hence the store-wide last resort.
 *  - the merchant has never opened Shopify's Search & Discovery app, so the
 *    curated metafield is empty. The fallback is the path that actually runs
 *    for most stores, not an edge case.
 */

import { describe, it, expect } from "vitest";
import { selectComplements, type ComplementAnchor } from "../services/connectors/shopify.adapter";

function prod(title: string, type: string, price: number | null, available = true) {
  return {
    id: title.replace(/\W+/g, "_"),
    title,
    product_type: type,
    variants: [{ id: `${title}-v1`, price: price === null ? null : String(price), available }],
  };
}

const BOARD: ComplementAnchor = { id: "The_Collection_Snowboard_Hydrogen", type: "snowboard", price: 600 };

/** The live catalogue, with the product types the store actually uses. */
const STORE = [
  prod("The Collection Snowboard: Hydrogen", "snowboard", 600),
  prod("Selling Plans Ski Wax", "accessories", 9.95),
  prod("The Complete Snowboard", "snowboard", 699.95),
  prod("Gift Card", "gift", 10, false),
  prod("The Multi-managed Snowboard", "snowboard", 629.95),
];

const titles = (l: any[]) => l.map((x) => x.title);

describe("choosing complements", () => {
  it("finds the accessory in a catalogue that is otherwise all snowboards", () => {
    const out = selectComplements(STORE, BOARD, { want: 3, maxRatio: 0.6 });
    expect(titles(out)).toEqual(["Selling Plans Ski Wax"]);
  });

  it("never offers the anchor back to the customer", () => {
    const out = selectComplements(STORE, BOARD, { want: 3, maxRatio: 0.6 });
    expect(titles(out)).not.toContain("The Collection Snowboard: Hydrogen");
  });

  it("never offers a competitor as an add-on", () => {
    // A second snowboard is what the customer was choosing BETWEEN. Offering
    // one as an accessory to the one they picked reads as not having listened.
    const cheaper = [...STORE, prod("The Budget Snowboard", "snowboard", 200)];
    const out = selectComplements(cheaper, BOARD, { want: 3, maxRatio: 0.6 });
    expect(titles(out)).not.toContain("The Budget Snowboard");
  });

  it("never offers something nobody can buy", () => {
    const out = selectComplements(STORE, BOARD, { want: 3, maxRatio: 0.6 });
    expect(titles(out)).not.toContain("Gift Card");
  });

  it("refuses anything that is not materially cheaper than the anchor", () => {
    const withBinding = [
      prod("Cheap Bindings", "bindings", 300), // 0.5 of 600 - an accessory
      prod("Premium Bindings", "bindings", 420), // 0.7 of 600 - an alternative purchase
    ];
    const out = selectComplements(withBinding, BOARD, { want: 3, maxRatio: 0.6 });
    expect(titles(out)).toEqual(["Cheap Bindings"]);
  });

  it("without a ratio, only requires not-more-expensive", () => {
    // This is the same-collection rule: a merchant grouping products together
    // is stronger evidence than a price, so the price bar is lower.
    const out = selectComplements([prod("Boots", "boots", 420)], BOARD, { want: 3 });
    expect(titles(out)).toEqual(["Boots"]);
  });

  it("skips an unpriced product when a ratio has to be proved", () => {
    const out = selectComplements([prod("Mystery", "accessories", null)], BOARD, { want: 3, maxRatio: 0.6 });
    expect(out).toEqual([]);
  });

  it("stops at the number asked for", () => {
    const many = [
      prod("Wax", "accessories", 10),
      prod("Strap", "accessories", 12),
      prod("Tool", "accessories", 14),
    ];
    expect(selectComplements(many, BOARD, { want: 2, maxRatio: 0.6 })).toHaveLength(2);
  });

  it("does not repeat a product across two sources", () => {
    // The adapter runs this over each collection and then the whole store; a
    // product in two collections must not be offered twice.
    const seen = new Set<string>();
    const first = selectComplements(STORE, BOARD, { want: 3, maxRatio: 0.6, seen });
    const second = selectComplements(STORE, BOARD, { want: 3, maxRatio: 0.6, seen });
    expect(titles(first)).toEqual(["Selling Plans Ski Wax"]);
    expect(second).toEqual([]);
  });

  it("returns nothing rather than padding, when the store has no accessories", () => {
    const boardsOnly = STORE.filter((p) => p.product_type === "snowboard");
    expect(selectComplements(boardsOnly, BOARD, { want: 3, maxRatio: 0.6 })).toEqual([]);
  });

  it("still works when the anchor has no price", () => {
    const noPrice: ComplementAnchor = { ...BOARD, price: null };
    const out = selectComplements(STORE, noPrice, { want: 3, maxRatio: 0.6 });
    expect(titles(out)).toEqual(["Selling Plans Ski Wax"]);
  });

  it("does not exclude on type when the store leaves product_type blank", () => {
    const untyped: ComplementAnchor = { ...BOARD, type: "" };
    const out = selectComplements([prod("Anything", "", 10)], untyped, { want: 3, maxRatio: 0.6 });
    expect(titles(out)).toEqual(["Anything"]);
  });
});
