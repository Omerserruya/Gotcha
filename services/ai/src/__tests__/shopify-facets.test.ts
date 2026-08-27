/**
 * The store describes itself; nothing here knows what a snowboard is.
 *
 * The fixture is the real Urban Supply catalogue as the adapter maps it, read
 * 2026-08-26. Its shape is the whole point: the store records Color, tags and
 * vendors, and records NO riding style, flex, board length or boot size - all
 * four of which the hardcoded profile made required questions.
 */

import { describe, it, expect } from "vitest";
import {
  deriveFacets,
  renderFacetsForPrompt,
  profileForStore,
  type CatalogFacets,
} from "../services/shopify-facets.service";
import type { DiscoveryProfile } from "@chatcenter/shared";

function board(title: string, price: number, color: string, available = true) {
  return {
    id: title.replace(/\W+/g, "_"),
    title,
    product_type: "snowboard",
    vendor: "Snowboard Vendor",
    tags: ["Sport", "Winter", "Snowboard"],
    options: [{ name: "Color" }],
    variants: [{ id: `${title}-v`, price: String(price), available, option1: color }],
  };
}

const CATALOG = [
  board("The Collection Snowboard: Hydrogen", 600, "Ice"),
  board("The Complete Snowboard", 699.95, "Powder"),
  board("The 3p Fulfilled Snowboard", 2629.95, "Dawn"),
  {
    id: "wax",
    title: "Selling Plans Ski Wax",
    product_type: "accessories",
    vendor: "Urban Supply - GOTCHA Demo",
    tags: ["Accessory", "Winter"],
    // Shopify's placeholder axis for a product with no real options.
    options: [{ name: "Title" }],
    variants: [{ id: "wax-v", price: "9.95", available: true, option1: "Default Title" }],
  },
  {
    id: "gift",
    title: "Gift Card",
    product_type: "giftcard",
    vendor: "Urban Supply - GOTCHA Demo",
    tags: [],
    options: [{ name: "Denominations" }],
    variants: [{ id: "g10", price: "10.00", available: false, option1: "$10" }],
  },
];

describe("deriving a store's shape", () => {
  const f = deriveFacets(CATALOG, "USD");

  it("groups by the store's own product types", () => {
    expect(f.productTypes.map((t) => t.type)).toEqual(["snowboard", "accessories", "giftcard"]);
    expect(f.productTypes[0].count).toBe(3);
  });

  it("prices each category from BUYABLE variants only", () => {
    const snow = f.productTypes.find((t) => t.type === "snowboard")!;
    expect(snow.priceMin).toBe(600);
    expect(snow.priceMax).toBe(2629.95);
    // Every gift card variant is unavailable, so it has no price a budget
    // question could be calibrated against.
    expect(f.productTypes.find((t) => t.type === "giftcard")!.priceMin).toBeNull();
  });

  it("collects the real option values", () => {
    const color = f.options.find((o) => o.name === "Color")!;
    expect(color.values.sort()).toEqual(["Dawn", "Ice", "Powder"]);
    expect(color.productTypes).toEqual(["snowboard"]);
  });

  it("drops Shopify's Default Title placeholder", () => {
    // "What Title would you like?" is worse than asking nothing.
    expect(f.options.map((o) => o.name)).not.toContain("Title");
  });

  it("scopes an option to the types that carry it", () => {
    // Denominations must never be offered to someone buying a snowboard.
    expect(f.options.find((o) => o.name === "Denominations")?.productTypes).toEqual(["giftcard"]);
  });

  it("ranks tags and vendors by how much of the catalogue they cover", () => {
    expect(f.tags[0]).toBe("Winter"); // on 4 products; Sport/Snowboard on 3
    expect(f.vendors).toContain("Snowboard Vendor");
  });

  it("reads tags off the shape the GraphQL mapper produces", () => {
    // Live regression: the GraphQL product selection did not request `tags`
    // and the mapper did not emit them, so every product read through the
    // PRIMARY path looked untagged and the catalogue block listed no tags at
    // all - while the tool still advertised a `tag` filter argument.
    const mapped = [{ id: "x", title: "T", product_type: "snowboard", vendor: "V",
      tags: ["Winter", "Premium"], options: [], variants: [{ price: "10", available: true }] }];
    expect(deriveFacets(mapped).tags.sort()).toEqual(["Premium", "Winter"]);
  });

  it("survives an empty or unreadable catalogue", () => {
    expect(deriveFacets([]).productTypes).toEqual([]);
    expect(deriveFacets(null as any).scanned).toBe(0);
  });
});

describe("the block the model reads", () => {
  const block = renderFacetsForPrompt(deriveFacets(CATALOG, "USD"))!;

  it("names each category with its real price range", () => {
    expect(block).toContain("snowboard (3 products, USD 600 - USD 2629.95)");
  });

  it("names the options and their values", () => {
    expect(block).toContain("Color [snowboard]: ");
    expect(block).toMatch(/Color \[snowboard\]: .*Ice/);
  });

  it("forbids interviewing on anything not listed", () => {
    expect(block).toContain("ONLY things this catalogue can be narrowed by");
  });

  it("tells the model to pass arguments rather than describe intentions", () => {
    expect(block).toContain("price_max");
    expect(block).toContain("not as prose");
  });

  it("is nothing at all when there is no catalogue to describe", () => {
    expect(renderFacetsForPrompt(null)).toBeNull();
    expect(renderFacetsForPrompt(deriveFacets([]))).toBeNull();
  });
});

describe("adapting the interview to the store", () => {
  const PROFILE = {
    goalKey: "product_recommendation",
    objective: "PRODUCT_RECOMMENDATION",
    readyAction: { type: "execute_tool", tool: "shopify.search_products" },
    facts: [
      { key: "product_category", type: "string", required: true },
      { key: "budget", type: "range", required: true },
      { key: "riding_style", type: "enum", required: true, enumValues: ["park", "freeride"] },
      { key: "height_cm", type: "number", required: false },
    ],
  } as unknown as DiscoveryProfile;

  const facets = deriveFacets(CATALOG, "USD");
  const adapted = profileForStore(PROFILE, facets);
  const byKey = (k: string) => adapted.facts.find((f) => f.key === k);

  it("stops requiring an attribute the store does not record", () => {
    // Shopify holds no riding style on any product here, so demanding it before
    // searching holds the shopper at a question that filters nothing.
    expect(byKey("riding_style")!.required).toBe(false);
  });

  it("keeps the demoted fact rather than deleting it", () => {
    // A volunteered "I'm a beginner" is still worth recording; it just cannot
    // be a gate.
    expect(byKey("riding_style")).toBeTruthy();
  });

  it("never demotes category or budget", () => {
    expect(byKey("product_category")!.required).toBe(true);
    expect(byKey("budget")!.required).toBe(true);
  });

  it("adds a fact for each real option, as optional", () => {
    const color = byKey("color")!;
    expect(color).toBeTruthy();
    expect(color.required).toBe(false);
    expect(color.enumValues).toContain("Powder");
  });

  it("keeps a required attribute the store DOES record", () => {
    const withSize = deriveFacets([
      { ...board("Boots", 200, "42"), options: [{ name: "Riding Style" }], variants: [{ price: "200", available: true, option1: "park" }] },
    ]);
    const kept = profileForStore(PROFILE, withSize).facts.find((f) => f.key === "riding_style")!;
    expect(kept.required).toBe(true);
  });

  it("changes nothing when the catalogue could not be read", () => {
    expect(profileForStore(PROFILE, null)).toBe(PROFILE);
  });

  it("does not duplicate a fact the profile already has", () => {
    const twice = profileForStore(profileForStore(PROFILE, facets), facets);
    expect(twice.facts.filter((f) => f.key === "color")).toHaveLength(1);
  });
});
