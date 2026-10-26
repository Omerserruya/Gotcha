/**
 * The cards are the products the reply talks about (2026-10-25, eval R5): G01
 * asked about a linen shirt and saw five tees; A02 asked about a cardigan and
 * got a slip dress with it, every turn.
 */
import { describe, it, expect } from "vitest";
import { namedCandidates, planAutoRecommendation } from "../services/recommendation-autosend.service";

const c = (id: string, title: string) => ({ productId: id, title, price: "100", currency: "ILS", inventoryState: "in_stock", url: `https://s/p/${id}`, attributes: {}, unknownAttributes: [], matchQuality: "exact" }) as any;
const candidates = [c("1", "Heavyweight Boxy Tee"), c("2", "Chunky Cardigan"), c("3", "Knit Slip Dress"), c("4", "Linen Shirt")];
const env = { provider: "woocommerce", tool: "woocommerce.list_products", status: "ok", candidates } as any;
const plan = (modelText: string) => planAutoRecommendation({ envelope: env, channelSupportsCards: true, alreadyStaged: false, modelText, locale: "he", maxProducts: 5 });

describe("★ the named products go out, in the text's order", () => {
  it("by key", () => {
    expect(plan("יש את PRODUCT_2 במידה M").selected.map((x) => x.productId)).toEqual(["2"]);
  });
  it("by exact title, keys and titles merged, each once", () => {
    expect(namedCandidates("Linen Shirt ו-PRODUCT_2, וגם Linen Shirt שוב", candidates).map((x) => x.productId)).toEqual(["4", "2"]);
  });
  it("nothing named: the policy's choice, as before", () => {
    expect(plan("הנה כמה אפשרויות").selected.map((x) => x.productId)).toEqual(["1", "2", "3", "4"]);
  });
  it("a key past the list is ignored", () => {
    expect(namedCandidates("PRODUCT_9", candidates)).toEqual([]);
  });
});

describe("★ e5 S5: no unnamed cards outside a recommendation search", () => {
  const plan2 = (modelText: string, o: any) => planAutoRecommendation({ envelope: env, channelSupportsCards: true, alreadyStaged: false, modelText, locale: "he", maxProducts: 5, ...o });
  it("a complaint that names nothing: no cards and no list", async () => {
    const p = plan2("ממש מצטערים על זה, נבדוק מה קרה", { unnamedAllowed: false });
    expect(p.selected).toEqual([]);
    expect(p.skipReason).toBe("not_named");
    const { decideDelivery } = await import("../services/recommendation-autosend.service");
    expect(decideDelivery(p, null)).toEqual({ structuredSent: false, useTextFallback: false });
  });
  it("a lookup that names nothing: the one best match", () => {
    expect(plan2("כן, יש במידה M", { unnamedAllowed: true, unnamedMax: 1 }).selected.map((x) => x.productId)).toEqual(["1"]);
  });
  it("a recommendation search: the policy's choice", () => {
    expect(plan2("הנה כמה אפשרויות", { unnamedAllowed: true }).selected).toHaveLength(4);
  });
});

describe("★ e5 S5: a title said twice prints once, in any language", () => {
  it("X (X), X, X", async () => {
    const { polishReply } = await import("../services/reply-style-check.service");
    const titles = ["Cotton Trench Coat", "Wool Blend Overcoat"];
    expect(polishReply("יש את Cotton Trench Coat (Cotton Trench Coat) בבז'", { locale: "he", productTitles: titles })).toBe("יש את Cotton Trench Coat בבז'");
    expect(polishReply("Wool Blend Overcoat, Wool Blend Overcoat in grey", { locale: "en", productTitles: titles })).toBe("Wool Blend Overcoat in grey");
  });
});

describe("★ e7 T5: a colour question about two or three matches gets their live options", () => {
  it("variations of up to three candidates ride along on a lookup", () => {
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const src: string = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
    expect(src).toContain("const checkedUpTo = Math.min(colours.length ? 4 : 3, envlp.candidates.length);");
    expect(src).toContain("for (let i = 0; i < checkedUpTo; i++) {");
    expect(src).toContain("VARIATIONS of PRODUCT_${i + 1}${mark} (live, already read)");
  });
  it("a complaint or a shipping question gets no unnamed cards", () => {
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const src: string = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
    expect(src).toContain('!["complaint", "shipping"].includes(classifySituation(opts.incomingMessage ?? "", false) ?? "")');
  });
});

describe("★ e8 U3: a product lacking the asked colour is never a card", () => {
  it("excluded ids are dropped, named or not", () => {
    const p = planAutoRecommendation({ envelope: env, channelSupportsCards: true, alreadyStaged: false, modelText: "יש את PRODUCT_1 ו-PRODUCT_4", locale: "he", maxProducts: 5, excludeIds: new Set(["1"]) });
    expect(p.selected.map((x) => x.productId)).toEqual(["4"]);
  });
});

describe("★ e10 X7", () => {
  it("a complaint: no cards, even named", () => {
    const p = planAutoRecommendation({ envelope: env, channelSupportsCards: true, alreadyStaged: false, modelText: "מצטערים. יש את PRODUCT_1", locale: "he", maxProducts: 5, noCards: true });
    expect(p.selected).toEqual([]);
    expect(p.skipReason).toBe("not_named");
  });
  it("longer words weigh more in the title rank", async () => {
    const { rankByTitleWords } = await import("../services/connectors/woocommerce.adapter");
    expect(rankByTitleWords([{ id: 1, name: "Heavyweight Boxy Tee" }, { id: 2, name: "Oversized Cotton T-Shirt" }], ["oversized", "tee"]).map((p: any) => p.id)).toEqual([2, 1]);
  });
});
