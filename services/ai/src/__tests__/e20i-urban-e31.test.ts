/**
 * urban-e31 and Omer's cart test (2026-10-28).
 *
 *   1. Omer's conv cmvrukohy00giim6yg1srbr3n: a gift for "בת זוג", an
 *      accessory, the bags shown; then "אוקי ויש מעיל לגברים ?", the overcoat;
 *      then the crossbody bag added to the cart. The add-ons were men's tee,
 *      trousers, sweater and chinos: the bag is Accessories + Women, both
 *      top-level, so Women was taken for its kind and every women's product
 *      was left out. Now: other accessories, for her, under a line that names
 *      the bag.
 *   2. U1 T1: "טרנץ' קל וקלאסי, ועיל צמר ארוך" came from the model as it is;
 *      the eaten letter is put back. Every Hebrew removal is token-bounded.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const STORE = "https://demo-store.example.com";
const H = vi.hoisted(() => ({
  products: {} as Record<string, any>, kv: new Map<string, string>(), sets: new Map<string, Set<string>>(),
  messages: [] as any[], created: [] as any[], tree: [] as any[],
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    getRedis: () => ({
      set: async (k: string, v: string, ..._o: any[]) => (H.kv.has(k) ? null : (H.kv.set(k, v), "OK")),
      del: async (k: string) => (H.kv.delete(k) ? 1 : 0),
      sadd: async (k: string, v: string) => { if (!H.sets.has(k)) H.sets.set(k, new Set()); H.sets.get(k)!.add(v); return 1; },
      smembers: async (k: string) => [...(H.sets.get(k) ?? [])],
      expire: async () => 1,
    }),
    publishEvent: async () => {},
    prisma: {
      conversation: {
        findFirst: async () => ({ channel: "WEBCHAT", channelAccountId: "ca1", status: "OPEN", isHandedOver: false, handledBy: "ai_agent", assignedAgentId: null }),
        update: async () => ({}),
      },
      channelAccount: { findFirst: async () => ({ credentials: { commerce: { productMessagingEnabled: true, suggestComplementary: true, addToCartEnabled: true } } }) },
      message: {
        findMany: async (a: any) => {
          let rows = H.messages.filter((m) =>
            (!a.where?.direction || m.direction === a.where.direction) &&
            (!a.where?.messageType?.contains || String(m.messageType).includes(a.where.messageType.contains)));
          if (a.orderBy?.createdAt === "desc") rows = [...rows].reverse();
          return rows.slice(0, a.take ?? rows.length);
        },
        findFirst: async (a: any) => [...H.messages].reverse().find((m) => !a.where?.direction || m.direction === a.where.direction) ?? null,
        create: async (a: any) => { const m = { id: `m${H.created.length}`, createdAt: new Date(), ...a.data }; H.created.push(m); return m; },
      },
    },
  };
});
vi.mock("../services/website-widget.service", () => ({ connectedWooStore: async () => ({ storeUrl: STORE }) }));
vi.mock("../services/discovery-integration.service", () => ({ resolveWooCurrency: async () => ({ currency: "ILS" }) }));
vi.mock("../services/widget-promotions.service", () => ({ listActivePromotions: async () => [] }));
vi.mock("../services/connectors/integration-framework", () => ({
  executeAdapterTool: async (o: any) => {
    const all = Object.values(H.products) as any[];
    if (o.toolFunctionName === "woocommerce.get_product") {
      const p = H.products[String(o.args.product_id)];
      return p ? { ok: true, result: p } : { ok: false, reason: "woocommerce_404" };
    }
    if (o.toolFunctionName === "woocommerce.list_product_categories") return { ok: true, result: H.tree };
    if (o.toolFunctionName === "woocommerce.list_products") {
      if (o.args.include) return { ok: true, result: all.filter((p) => o.args.include.includes(String(p.id))) };
      return { ok: true, result: all.filter((p) => o.args.category == null || p.categories.some((c: any) => String(c.id) === String(o.args.category))) };
    }
    if (o.toolFunctionName === "woocommerce.list_product_variations") return { ok: true, result: [] };
    return { ok: false, reason: "unexpected" };
  },
}));

import {
  offerCrossSellAfterCart, addedToCartLine, audienceWhenShown, recipientAudienceOf, wooComplementaryProducts,
} from "../services/woo-chat-turn.service";
import { polishReply, stripPrices, dropBelow } from "../services/reply-style-check.service";

// The urban store as it is on dev (read-only SELECT, 2026-10-28).
const ACC = 56, MEN = 58, WOMEN = 57, COATS = 54, PANTS = 53, TEES = 49, KNIT = 52, DRESSES = 55, CLOTHING = 48;
const TREE = [
  { id: ACC, name: "Accessories", parent: 0 }, { id: CLOTHING, name: "Clothing", parent: 0 },
  { id: MEN, name: "Men", parent: 0 }, { id: WOMEN, name: "Women", parent: 0 },
  { id: DRESSES, name: "Dresses", parent: CLOTHING }, { id: COATS, name: "Jackets &amp; Coats", parent: CLOTHING },
  { id: KNIT, name: "Knitwear", parent: CLOTHING }, { id: PANTS, name: "Pants", parent: CLOTHING }, { id: TEES, name: "T-Shirts", parent: CLOTHING },
];
const product = (id: number, name: string, cats: number[], extra: any = {}) => ({
  id, name, slug: name.toLowerCase().replace(/ /g, "-"), type: "simple", status: "publish", catalog_visibility: "visible",
  price: "100", regular_price: "100", stock_status: "instock", purchasable: true, permalink: `${STORE}/p/${id}/`,
  images: [], categories: cats.map((id) => ({ id })), cross_sell_ids: [], upsell_ids: [], ...extra,
});
const at = (i: number) => new Date(Date.UTC(2026, 9, 28, 8, 23, i));
const cards = (ids: number[]) => ({ commerce: { products: ids.map((id) => ({ productId: String(id), title: H.products[String(id)].name })) } });

beforeEach(() => {
  H.kv.clear(); H.sets.clear(); H.created = []; H.tree = TREE;
  H.products = Object.fromEntries([
    product(36, "Heavyweight Boxy Tee", [TEES, MEN]),
    product(243, "Cotton Cable Sweater", [KNIT, MEN]),
    product(271, "Pleated Wool Trousers", [PANTS, MEN]),
    product(313, "Chino Pants", [PANTS, MEN]),
    product(329, "Wool Blend Overcoat", [COATS, WOMEN, MEN]),
    product(330, "Slip Dress", [DRESSES, WOMEN]),
    product(421, "Canvas Tote Bag", [ACC, WOMEN, MEN]),
    product(425, "Leather Crossbody Bag", [ACC, WOMEN]),
    product(429, "Ribbed Wool Beanie", [ACC, WOMEN, MEN]),
    product(435, "Lambswool Scarf", [ACC, WOMEN, MEN]),
    product(440, "Crew Socks 3-Pack", [ACC, WOMEN, MEN], { stock_status: "outofstock" }),
    product(443, "Leather Belt", [ACC, WOMEN, MEN]),
    product(450, "Mens Leather Wallet", [ACC, MEN]),
  ].map((p) => [String(p.id), p]));
  // Omer's conversation, message by message.
  H.messages = [
    { direction: "INBOUND", messageType: "text", body: "היי", createdAt: at(0) },
    { direction: "OUTBOUND", messageType: "text", body: "היי! מה מחפשים?", createdAt: at(7) },
    { direction: "INBOUND", messageType: "text", body: "מחפש מתנה לבת זוגג שלי", createdAt: at(29) },
    { direction: "OUTBOUND", messageType: "text", body: "איזה כיף, מתנה! בגד או אקססורי?", createdAt: at(38) },
    { direction: "INBOUND", messageType: "text", body: "אקססורי חמוד", createdAt: at(47) },
    { direction: "OUTBOUND", messageType: "text", body: "הנה כמה אפשרויות שיכולות להתאים:", createdAt: at(64) },
    { direction: "OUTBOUND", messageType: "woo_product_carousel", body: "", metadata: cards([425, 421]), createdAt: at(65) },
    { direction: "INBOUND", messageType: "text", body: "אוקי ויש מעיל לגברים ?", createdAt: at(75) },
    { direction: "OUTBOUND", messageType: "text", body: "מעיל ארוך מצמר בקווים מוקפדים.", createdAt: at(86) },
    { direction: "OUTBOUND", messageType: "woo_product", body: "", metadata: cards([329]), createdAt: at(87) },
  ];
});

describe("1. the crossbody bag added after the men's coat (Omer, 2026-10-28)", () => {
  it("names the bag, and the add-ons are other accessories for her", async () => {
    expect(await offerCrossSellAfterCart({ tenantId: "T", conversationId: "c1", productId: "425" })).toBe("sent");
    expect(H.created[0].body).toBe("ראיתי שהוספת לסל את תיק הצד! עוד מוצרים שיכולים להתאים לך:");
    const ids = H.created[1].metadata.commerce.products.map((p: any) => p.productId);
    // Not a bag (the tote is a substitute and was shown), not out of stock, not the men's wallet, no clothes.
    expect(ids).toEqual(["429", "435", "443"]);
    for (const no of ["36", "243", "271", "313", "330", "421", "440", "450"]) expect(ids).not.toContain(no);
  });
  it("who it was for when it was shown: the partner, not the later \"לגברים\"", () => {
    expect(audienceWhenShown(H.messages, "425")).toBe("women");
    expect(audienceWhenShown(H.messages, "329")).toBe("men");
    expect(audienceWhenShown(H.messages, "999")).toBe("men");
  });
  it("a unisex product shown for her: nothing only for men", async () => {
    const got: any = await wooComplementaryProducts("T", "421", 4, { audience: "women" });
    expect(got.result.map((p: any) => String(p.id))).toEqual(["429", "435", "443"]);
  });
  it("a clothing anchor still gets accessories first, then clothes of other kinds for the same person", async () => {
    const got: any = await wooComplementaryProducts("T", "330", 6, { audience: "women" });
    const ids = got.result.map((p: any) => String(p.id));
    expect(ids.slice(0, 4)).toEqual(["421", "425", "429", "435"]);
    expect(ids).not.toContain("36");
    expect(ids).not.toContain("450");
  });
  it("nothing fits: nothing, never something unrelated", async () => {
    for (const id of ["429", "435", "443", "421"]) delete H.products[id];
    expect(await offerCrossSellAfterCart({ tenantId: "T", conversationId: "c1", productId: "425" })).toBe("no_add_ons");
    expect(H.created).toEqual([]);
  });
});

describe("the line names what was added", () => {
  it.each([
    ["Leather Crossbody Bag", "ראיתי שהוספת לסל את תיק הצד! עוד מוצרים שיכולים להתאים לך:"],
    ["Canvas Tote Bag", "ראיתי שהוספת לסל את תיק הבד! עוד מוצרים שיכולים להתאים לך:"],
    ["Leather Belt", "ראיתי שהוספת לסל את החגורה! עוד מוצרים שיכולים להתאים לך:"],
    ["Chino Pants", "ראיתי שהוספת לסל את המכנסיים! עוד מוצרים שיכולים להתאים לך:"],
    ["Cotton Trench Coat", "ראיתי שהוספת לסל את הטרנץ'! עוד מוצרים שיכולים להתאים לך:"],
    ["Linen Overshirt", "ראיתי שהוספת לסל את החולצה העליונה! עוד מוצרים שיכולים להתאים לך:"],
  ])("%s", (title, line) => {
    expect(addedToCartLine("he", title)).toBe(line);
    expect(line).not.toMatch(/[–—־]/);
  });
  it("no safe Hebrew name: the generic line; English names the title", () => {
    expect(addedToCartLine("he", "Gift Card")).toBe("עוד מוצרים שיכולים להתאים לך:");
    expect(addedToCartLine("he", "")).toBe("עוד מוצרים שיכולים להתאים לך:");
    expect(addedToCartLine("en", "Leather Belt")).toBe("I see you added the Leather Belt to your cart! More products that may suit you:");
  });
});

describe("who a message is for", () => {
  it.each([
    ["מחפש מתנה לבת זוגג שלי", "women"], ["משהו לבת הזוג", "women"], ["לחברה שלי", "women"], ["a gift for my girlfriend", "women"],
    ["מתנה לבן זוג", "men"], ["יש מעיל לגברים ?", "men"], ["אקססורי חמוד", null], ["בשבילי", null],
  ])("%s", (t, a) => expect(recipientAudienceOf(t)).toBe(a));
});

describe("2. a product word with its first letter eaten (urban-e31 U1 T1)", () => {
  const polish = (t: string) => polishReply(t, { locale: "he", incomingMessage: "מחפש מעיל" });
  it("the letter is put back", () => {
    expect(polish("מצאתי שני מעילים שעשויים להתאים: טרנץ' קל וקלאסי, ועיל צמר ארוך.")).toContain("ומעיל צמר ארוך");
    expect(polish("יש ולצה לבנה וגם כנסיים שחורים.")).toContain("יש חולצה לבנה וגם מכנסיים שחורים");
  });
  it("whole words stay as they are", () => {
    for (const t of ["מעיל צמר ארוך ומעיל קל.", "המעיל והמכנסיים כאן.", "זה מועיל מאוד.", "כאמור לעיל, יש משלוח.", "מעילים חמים ומכנסיים.", "טרנץ' וחולצה."]) {
      expect(polish(t)).toBe(t);
    }
  });
});

describe("every Hebrew removal is token-bounded", () => {
  it("an unbacked price: the verb goes only when it is its own word", () => {
    expect(stripPrices("איכות מעולה 299 ₪ לכל חולצה.", ["299"])).toBe("איכות מעולה לכל חולצה.");
    expect(stripPrices("החולצה עולה 299 ₪.", ["299"])).toBe("החולצה.");
    expect(stripPrices("this 299 ILS shirt", ["299"])).toBe("this shirt");
  });
  it("\"below\" goes, \"מלמטה\" stays", () => {
    expect(dropBelow("הכפתורים מלמטה סגורים.")).toBe("הכפתורים מלמטה סגורים.");
    expect(dropBelow("יש שני מעילים כאן למטה.")).toBe("יש שני מעילים.");
  });
  it("\"ראו:\" goes, \"קראו:\" stays", () => {
    const t = "כדאי לקרוא את ההוראות. קראו: כביסה עדינה";
    expect(polishReply(t, { locale: "he", incomingMessage: "איך מכבסים" })).toContain("קראו: כביסה עדינה");
  });
});
