import { describe, it, expect, beforeEach, vi } from "vitest";
vi.mock("../services/ai.service", () => ({ generateEmbeddings: vi.fn(async () => []) }));
import { semanticProductSearch, productDoc, _resetCatalogSemanticCache, MAX_PRODUCTS } from "../services/catalog-semantic.service";

// A deterministic stand-in for the embedding model: concept words map to axes,
// so "מתנה לאמא" and "gift for mother" land on the same axis as a product
// whose text says "gift".
const AXES: Record<string, string[]> = {
  gift: ["gift", "מתנה", "present"],
  warm: ["warm", "חם", "wool", "צמר", "winter", "חורף"],
  shoe: ["shoe", "נעל", "sneaker"],
  bag: ["bag", "תיק", "tote"],
};
const KEYS = Object.keys(AXES);
let calls = 0;
const fake = async (_t: string, inputs: string[]) => {
  calls += inputs.length;
  return inputs.map((text) => {
    const low = text.toLowerCase();
    const v = KEYS.map((k) => (AXES[k].some((w) => low.includes(w)) ? 1 : 0));
    return [...v, 0.05];
  });
};

const products = [
  { id: 1, name: "Wool Coat", categories: [{ name: "Coats" }], short_description: "<p>A warm winter coat</p>", price: "450" },
  { id: 2, name: "Gift Box Candle", categories: [{ name: "Home" }], tags: [{ name: "gift" }], price: "120" },
  { id: 3, name: "Canvas Tote", categories: [{ name: "Bags" }], price: "90" },
  { id: 4, name: "Runner", categories: [{ name: "Sneakers" }], price: "300" },
];

describe("catalog semantic search", () => {
  beforeEach(() => { _resetCatalogSemanticCache(); calls = 0; });

  it("finds by meaning across languages: a Hebrew ask on English titles", async () => {
    const r = await semanticProductSearch({ tenantId: "t", storeKey: "s", products, query: "משהו חם לחורף", embed: fake });
    expect(r[0]?.product.id).toBe(1);
  });

  it("finds a gift by its tag when no title says gift", async () => {
    const r = await semanticProductSearch({ tenantId: "t", storeKey: "s", products, query: "מתנה לאמא", embed: fake });
    expect(r.map((x) => x.product.id)).toEqual([2]);
  });

  it("returns nothing when nothing is close (never a random product)", async () => {
    const r = await semanticProductSearch({ tenantId: "t", storeKey: "s", products, query: "laptop charger", embed: fake });
    expect(r).toEqual([]);
  });

  it("embeds each product once, then only what changed", async () => {
    await semanticProductSearch({ tenantId: "t", storeKey: "s", products, query: "tote", embed: fake });
    const first = calls;
    expect(first).toBe(products.length + 1);
    await semanticProductSearch({ tenantId: "t", storeKey: "s", products, query: "tote", embed: fake });
    expect(calls).toBe(first);
    const changed = products.map((p) => (p.id === 3 ? { ...p, name: "Canvas Tote Bag" } : p));
    await semanticProductSearch({ tenantId: "t", storeKey: "s", products: changed, query: "bag", embed: fake });
    expect(calls).toBe(first + 2);
  });

  it("skips catalogues too big to rank inside a turn", async () => {
    const big = Array.from({ length: MAX_PRODUCTS + 1 }, (_, i) => ({ id: i, name: "Tote" }));
    expect(await semanticProductSearch({ tenantId: "t", storeKey: "b", products: big, query: "tote", embed: fake })).toEqual([]);
    expect(calls).toBe(0);
  });

  it("never throws: an embedding failure is an empty result", async () => {
    const boom = async () => { throw new Error("down"); };
    expect(await semanticProductSearch({ tenantId: "t", storeKey: "x", products, query: "tote", embed: boom as any })).toEqual([]);
  });

  it("productDoc reads Woo and Shopify shapes", () => {
    expect(productDoc(products[0])).toContain("Wool Coat");
    expect(productDoc(products[0])).toContain("warm winter coat");
    const shop = { id: 9, title: "Silk Scarf", product_type: "Accessories", tags: ["gift"], variants: [{ option1: "Red" }, { option1: "Blue" }] };
    const d = productDoc(shop);
    expect(d).toContain("Silk Scarf");
    expect(d).toContain("Accessories");
    expect(d).toContain("gift");
    expect(d).toContain("Red, Blue");
  });
});
