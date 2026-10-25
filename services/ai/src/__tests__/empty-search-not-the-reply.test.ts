/**
 * An empty product search is data, not the reply (2026-10-25, eval R2).
 * "לא מצאתי מוצרים שמתאימים לחיפוש הזה." replaced whole answers, a complaint's
 * included, and "black tank top" missed the store's "Organic Rib Tank".
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { searchWords, rankByTitleWords } from "../services/connectors/woocommerce.adapter";

describe("★ a multi-word search that finds nothing is retried word by word", () => {
  it("the words worth searching alone, longest first, no filler", () => {
    expect(searchWords("black tank top")).toEqual(["black", "tank", "top"]);
    expect(searchWords("linen shirt in size M")).toEqual(["linen", "shirt"]);
    expect(searchWords("")).toEqual([]);
  });
  it("only products whose title carries a query word, best first", () => {
    const products = [
      { id: 1, name: "Heavyweight Boxy Tee" },  // matched "black" in its body only
      { id: 2, name: "Organic Rib Tank" },
      { id: 3, name: "Rib Tank Top" },
    ];
    expect(rankByTitleWords(products, searchWords("black tank top")).map((p) => p.id)).toEqual([3, 2]);
  });
});

describe("★ the bot keeps the model's reply when the search is empty", () => {
  it("the canned line only for a model that said nothing", () => {
    const src = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
    expect(src).toContain('const emptySearch = !!productEnvelope && productEnvelope.status === "no_results" && productEnvelope.candidates.length === 0;');
    expect(src).toContain("if (emptySearch && replyText?.trim()) {");
  });
  it("the adapter retries the category, then at most 3 singular words", () => {
    const src = readFileSync(join(__dirname, "../services/connectors/woocommerce.adapter.ts"), "utf8");
    expect(src).toContain("/products/categories?per_page=5&search=");
    expect(src).toContain("const stems = Array.from(new Set(words.map(singular))).slice(0, 3);");
  });

  it("★ e5 S1: plurals become the singular a title contains", async () => {
    const { singular } = await import("../services/connectors/woocommerce.adapter");
    expect(["hoodies", "chinos", "coats", "jackets", "dresses", "bags", "dress", "glass"].map(singular))
      .toEqual(["hoodie", "chino", "coat", "jacket", "dress", "bag", "dress", "glass"]);
    expect(rankByTitleWords([{ id: 1, name: "Cropped Hoodie" }, { id: 2, name: "Chino Pants" }], ["hoodie"]).map((p) => p.id)).toEqual([1]);
  });
});

describe("★ e7 T2: title words decide, not a description match", () => {
  it("'shirt' keeps the shirts, drops hoodies matched by their copy", () => {
    const list = [{ id: 1, name: "Heavyweight Hoodie" }, { id: 2, name: "Relaxed Linen Shirt" }, { id: 3, name: "Poplin Overshirt" }];
    expect(rankByTitleWords(list, ["shirt"]).map((p) => p.id)).toEqual([2, 3]);
  });
  it("the adapter filters a non-empty result by title words when any match", () => {
    const src = readFileSync(join(__dirname, "../services/connectors/woocommerce.adapter.ts"), "utf8");
    expect(src).toContain("const byTitle = rankByTitleWords(list, Array.from(new Set(words.map(singular))));");
  });
});
