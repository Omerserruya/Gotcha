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
