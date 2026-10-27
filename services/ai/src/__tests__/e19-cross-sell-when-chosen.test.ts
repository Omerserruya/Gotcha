/**
 * Cross-sell when the customer settles on a product (2026-10-26, Omer's urban
 * test: woocommerce.complementary_products was offered and never called).
 *
 *   (i)  "אני לוקח את הטרנץ'": the answer, then "זה הולך מצוין עם:" and the add-on cards.
 *   (ii) Add to cart on a card: the same line and cards, written by the server.
 *   Both: the widget's toggle on, the bot has the conversation, once per product
 *   across both signals (and the model's own call), nothing when the store has
 *   no add-ons, never a product the customer already chose.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const STORE = "https://demo-store.example.com";
const H = vi.hoisted(() => ({
  products: {} as Record<string, any>, kv: new Map<string, string>(), sets: new Map<string, Set<string>>(),
  conv: null as any, account: null as any, created: [] as any[], events: [] as any[], lastInbound: null as any,
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
    publishEvent: async (e: any) => { H.events.push(e); },
    prisma: {
      conversation: {
        findFirst: async () => H.conv,
        update: async () => ({}),
      },
      channelAccount: { findFirst: async () => H.account },
      message: {
        findMany: async () => [],
        findFirst: async () => H.lastInbound,
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
    if (o.toolFunctionName === "woocommerce.list_products") {
      if (o.args.include) return { ok: true, result: all.filter((p) => o.args.include.includes(String(p.id))) };
      return { ok: true, result: all.filter((p) => (o.args.category == null || p.categories.some((c: any) => String(c.id) === String(o.args.category))) && !(o.args.exclude ?? []).includes(String(p.id))) };
    }
    if (o.toolFunctionName === "woocommerce.list_product_variations") return { ok: true, result: [] };
    return { ok: false, reason: "unexpected" };
  },
}));

import {
  commitsToBuy, crossSellAnchor, claimCrossSell, crossSellCards, offerCrossSellAfterCart, withTheBot, goesWellWithLine,
} from "../services/woo-chat-turn.service";

const product = (id: number, name: string, cat: number, extra: any = {}) => ({
  id, name, slug: name.toLowerCase().replace(/ /g, "-"), type: "simple", status: "publish", catalog_visibility: "visible",
  price: "100", regular_price: "100", stock_status: "instock", purchasable: true, permalink: `${STORE}/p/${id}/`,
  images: [], categories: [{ id: cat }], cross_sell_ids: [], upsell_ids: [], ...extra,
});
const WEB = { credentials: { commerce: { productMessagingEnabled: true, suggestComplementary: true, addToCartEnabled: true } } };
const BOT = { channel: "WEBCHAT", channelAccountId: "ca1", status: "OPEN", isHandedOver: false, handledBy: "ai_agent", assignedAgentId: null };
const shown = [
  { productId: "41", handle: "cotton-trench-coat", title: "Cotton Trench Coat", batch: 0 },
  { productId: "42", handle: "wool-blend-overcoat", title: "Wool Blend Overcoat", batch: 0 },
];

beforeEach(() => {
  H.kv.clear(); H.sets.clear(); H.created = []; H.events = [];
  H.conv = { ...BOT }; H.account = WEB; H.lastInbound = { body: "אני מחפש מעיל" };
  H.products = {
    "41": product(41, "Cotton Trench Coat", 7, { cross_sell_ids: [60] }),
    "42": product(42, "Wool Blend Overcoat", 7),
    "60": product(60, "Wool Scarf", 9),
    "61": product(61, "Leather Gloves", 7),
    "70": product(70, "Lonely Mug", 99),
  };
});

describe("the customer settles on a product", () => {
  for (const t of ["אני לוקח את הטרנץ'", "אני לוקחת אותו", "אקח במידה M", "סגור, אזמין את המעיל", "הוספתי את המעיל לסל", "I'll take it", "I added it to the cart"]) {
    it(t, () => expect(commitsToBuy(t)).toBe(true));
  }
  for (const t of ["יש במידה M?", "אקח במידה M?", "לא אקח את זה", "אני לא לוקח", "שלח לי", "מה המחיר?", "אני מחפש מעיל", "I won't take it", "Should I take the M?"]) {
    it(`not: ${t}`, () => expect(commitsToBuy(t)).toBe(false));
  }
});

describe("which product", () => {
  it("the one of the last cards the words name", () => {
    expect(crossSellAnchor("אני לוקח את הטרנץ'", shown)).toBe("41");
    expect(crossSellAnchor("אקח את מעיל הצמר", shown)).toBe("42");
    expect(crossSellAnchor("I'll take the Wool Blend Overcoat", shown)).toBe("42");
  });
  it("two cards, none named: no guess; the product page they are on, if any", () => {
    expect(crossSellAnchor("אני לוקח", shown)).toBeNull();
    expect(crossSellAnchor("אני לוקח", shown, "42")).toBe("42");
  });
  it("one card: that one", () => {
    expect(crossSellAnchor("אני לוקח", [shown[0]])).toBe("41");
  });
});

describe("once per product, the add-ons from the store", () => {
  it("claimed once", async () => {
    expect(await claimCrossSell("c1", "41")).toBe(true);
    expect(await claimCrossSell("c1", "41")).toBe(false);
    expect(await claimCrossSell("c1", "42")).toBe(true);
  });
  it("linked first, then another kind; never the product itself, one already chosen, or one already shown", async () => {
    await claimCrossSell("c1", "42");
    await claimCrossSell("c1", "41");
    const r = await crossSellCards("T", "c1", { storeUrl: STORE, channelAccountId: "ca1", addToCartEnabled: true }, "41");
    const ids = (r!.metadata as any).commerce.products.map((p: any) => p.productId);
    // 60 is linked; 42 and 61 share the coat's category (a substitute, never); 70 is another kind.
    expect(ids).toEqual(["60", "70"]);
    expect((r!.metadata as any).complementaryFor).toBe("41");
  });
  it("no add-ons in the store (only the anchor's own kind): nothing", async () => {
    H.products = { "70": H.products["70"], "71": product(71, "Other Mug", 99) };
    expect(await crossSellCards("T", "c1", { storeUrl: STORE, channelAccountId: "ca1", addToCartEnabled: true }, "70")).toBeNull();
  });
});

describe("(ii) add to cart", () => {
  it("sends the line and the cards as the bot's messages, and tells the widget", async () => {
    expect(await offerCrossSellAfterCart({ tenantId: "T", conversationId: "c1", productId: "41" })).toBe("sent");
    expect(H.created.map((m) => [m.direction, m.messageType, m.senderName])).toEqual([
      ["OUTBOUND", "text", "AI Bot"], ["OUTBOUND", "woo_product_carousel", "AI Bot"],
    ]);
    expect(H.created[0].body).toBe(goesWellWithLine("he"));
    expect(H.events.map((e) => [e.event, e.data.channel])).toEqual([["message:new", "WEBCHAT"], ["message:new", "WEBCHAT"]]);
  });
  it("once: a second add of the same product, or after \"אני לוקח\" already offered it, sends nothing", async () => {
    await offerCrossSellAfterCart({ tenantId: "T", conversationId: "c1", productId: "41" });
    expect(await offerCrossSellAfterCart({ tenantId: "T", conversationId: "c1", productId: "41" })).toBe("already_offered");
    await claimCrossSell("c1", "42");
    expect(await offerCrossSellAfterCart({ tenantId: "T", conversationId: "c1", productId: "42" })).toBe("already_offered");
    expect(H.created).toHaveLength(2);
  });
  it("in English when the customer writes English", async () => {
    H.lastInbound = { body: "looking for a coat please" };
    await offerCrossSellAfterCart({ tenantId: "T", conversationId: "c1", productId: "41" });
    expect(H.created[0].body).toBe("This goes great with:");
  });
  it("nothing: toggle off, a person has it, handed over, closed, no add-ons", async () => {
    H.account = { credentials: { commerce: { productMessagingEnabled: true, suggestComplementary: false } } };
    expect(await offerCrossSellAfterCart({ tenantId: "T", conversationId: "c1", productId: "41" })).toBe("toggle_off");
    H.account = WEB;
    for (const c of [{ handledBy: "human" }, { isHandedOver: true }, { status: "WAITING" }, { status: "CLOSED" }, { assignedAgentId: "u1" }]) {
      H.conv = { ...BOT, ...c };
      expect(await offerCrossSellAfterCart({ tenantId: "T", conversationId: "c1", productId: "41" })).toBe("not_with_the_bot");
    }
    H.conv = { ...BOT };
    H.products = { "70": H.products["70"], "71": product(71, "Other Mug", 99) };
    expect(await offerCrossSellAfterCart({ tenantId: "T", conversationId: "c1", productId: "70" })).toBe("no_add_ons");
    expect(H.created).toEqual([]);
  });
  it("no add-ons: the once is not spent (dev 2026-10-27: no_add_ons, then already_offered)", async () => {
    H.products = { "70": H.products["70"], "71": product(71, "Other Mug", 99) };
    expect(await offerCrossSellAfterCart({ tenantId: "T", conversationId: "c1", productId: "70" })).toBe("no_add_ons");
    H.products["72"] = product(72, "Tea Towel", 98);
    expect(await offerCrossSellAfterCart({ tenantId: "T", conversationId: "c1", productId: "70" })).toBe("sent");
  });
  it("the bot has it: open, not handed over, the AI handling, no person assigned", () => {
    expect(withTheBot(BOT)).toBe(true);
    expect(withTheBot(null)).toBe(false);
  });
});

describe("wired", () => {
  const bot = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
  const route = readFileSync(join(__dirname, "../routes/embedded-chat.ts"), "utf8");
  it("(i) after the answer; the add-ons replace any card the model chose this turn (urban-e25)", () => {
    expect(bot).toContain("!awaitingApproval && !pendingEscalation && commitsToBuy(opts.incomingMessage)) {");
    expect(bot).not.toContain("!wooTurn.staged.length && commitsToBuy(opts.incomingMessage)");
    expect(bot).toContain("replyText = `${choiceAckLine(replyLocale)}\\n${goesWellWithLine(replyLocale)}`;");
  });
  it("the model's own call counts toward once", () => {
    expect(bot).toContain("!(await claimCrossSell(opts.conversationId, anchorId))");
  });
  it("(ii) after the cart answer, off the response path", () => {
    expect(route).toContain("res.json({ data });\n    // The shopper chose this product");
    expect(route).toContain("offerCrossSellAfterCart({ tenantId: conv.tenantId, conversationId: conv.id, productId })");
  });
});
