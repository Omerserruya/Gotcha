/**
 * Dev, 2026-10-26, Omer's urban widget test (conv cmvpghp1…):
 *   T2 "לגברים": the reply said "שני מעילים למטה" and no card went out (it named
 *      the coats in Hebrew, so none was "named").
 *   T3 "שלח לי": the model passed {handle:"cotton-trench-coat"} (the history shows
 *      cards by title only), staging kept numeric ids only, and the customer got
 *      "מצטערים, לא הצלחנו לשלוח את הקרוסלה כרגע. אפשר לשלוח כרטיס מוצר אחד בכל פעם".
 *
 *   - A handle, slug or title the conversation's cards showed is that product.
 *   - Else the store's product with that slug; else no card, as before.
 *   - A reply that says the cards failed loses that sentence; the cards shown
 *     last are resent. "Below" with nothing below loses the word.
 *   - A reply that points at cards below gets them.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const STORE = "https://demo-store.example.com";
const H = vi.hoisted(() => ({ products: {} as Record<string, any>, messages: [] as any[], calls: [] as any[] }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    prisma: {
      conversation: { findFirst: async () => ({ channel: "WEBCHAT", channelAccountId: "ca1" }) },
      channelAccount: { findFirst: async () => ({ id: "ca1", credentials: { commerce: { productMessagingEnabled: true } } }) },
      message: { findMany: async () => H.messages },
    },
  };
});
vi.mock("../services/website-widget.service", () => ({ connectedWooStore: async () => ({ storeUrl: STORE }) }));
vi.mock("../services/discovery-integration.service", () => ({ resolveWooCurrency: async () => ({ currency: "ILS" }) }));
vi.mock("../services/widget-promotions.service", () => ({ listActivePromotions: async () => [] }));
vi.mock("../services/connectors/integration-framework", () => ({
  executeAdapterTool: async (o: any) => {
    H.calls.push(o);
    if (o.toolFunctionName === "woocommerce.get_product") {
      const p = o.args.slug ? Object.values(H.products).find((x: any) => x.slug === o.args.slug) : H.products[String(o.args.product_id)];
      return p ? { ok: true, result: p } : { ok: false, reason: "woocommerce_404" };
    }
    if (o.toolFunctionName === "woocommerce.list_product_variations") return { ok: true, result: [] };
    return { ok: false, reason: "unexpected" };
  },
}));

import { prepareWebchatCommerceTurn, resolveWooRef } from "../services/woo-chat-turn.service";
import { cardSendTrouble, stripCardSendTrouble, pointsToCardsBelow, dropBelow } from "../services/reply-style-check.service";
import { planAutoRecommendation } from "../services/recommendation-autosend.service";

const product = (id: number, name: string, slug: string) => ({
  id, name, slug, type: "simple", status: "publish", catalog_visibility: "visible", price: "799", regular_price: "799",
  stock_status: "instock", purchasable: true, permalink: `${STORE}/product/${slug}/`, images: [{ src: `${STORE}/i.jpg` }],
});
const cardRow = (products: Array<{ productId: string; handle: string; title: string }>) => ({
  metadata: { commerce: { kind: "woo_commerce", products } },
});

beforeEach(() => {
  H.calls = [];
  H.products = {
    "41": product(41, "Cotton Trench Coat", "cotton-trench-coat-2"),
    "42": product(42, "Wool Blend Overcoat", "wool-blend-overcoat"),
    "50": product(50, "Linen Shirt", "linen-shirt"),
  };
  H.messages = [cardRow([
    { productId: "41", handle: "cotton-trench-coat-2", title: "Cotton Trench Coat" },
    { productId: "42", handle: "wool-blend-overcoat", title: "Wool Blend Overcoat" },
  ])];
});

describe("a card reference that is not an id", () => {
  it("the call that failed: a handle-only carousel on a Woo turn sends the cards", async () => {
    const turn = (await prepareWebchatCommerceTurn({ tenantId: "T", conversationId: "c1" }))!;
    const r = await turn.sendShopifyProducts({ products: [{ handle: "cotton-trench-coat" }, { handle: "wool-blend-overcoat" }] });
    expect(r).toMatchObject({ ok: true });
    expect((r as any).products.map((p: any) => p.title)).toEqual(["Cotton Trench Coat", "Wool Blend Overcoat"]);
    expect(turn.staged).toHaveLength(1);
  });
  it("the title a card showed, any case, is that product", async () => {
    const shown = [{ productId: "41", handle: "cotton-trench-coat-2", title: "Cotton Trench Coat", batch: 0 }];
    expect(await resolveWooRef("T", shown, { handle: "Cotton Trench Coat" })).toBe("41");
    expect(await resolveWooRef("T", shown, { productId: "cotton trench coat" })).toBe("41");
  });
  it("a slug no card showed: the store's product with that slug", async () => {
    expect(await resolveWooRef("T", [], { handle: "linen-shirt" })).toBe("50");
    expect(H.calls.at(-1)).toMatchObject({ toolFunctionName: "woocommerce.get_product", args: { slug: "linen-shirt" } });
  });
  it("an id stays an id; nothing that matches is no card", async () => {
    expect(await resolveWooRef("T", [], { productId: "42" })).toBe("42");
    expect(await resolveWooRef("T", [], { handle: "made-up-coat" })).toBeNull();
    const turn = (await prepareWebchatCommerceTurn({ tenantId: "T", conversationId: "c1" }))!;
    expect(await turn.sendShopifyProducts({ products: [{ handle: "made-up-coat" }] })).toMatchObject({ ok: false });
  });
});

describe("a failed card send is never the customer's news", () => {
  const SENT = "מצטערים, לא הצלחנו לשלוח את הקרוסלה כרגע. אפשר לשלוח כרטיס מוצר אחד בכל פעם: מה בא לך, טרנץ' או מעיל צמר?";
  it("the reply that went out: the trouble goes, the question stays", () => {
    expect(cardSendTrouble(SENT)).toBe(true);
    expect(stripCardSendTrouble(SENT)).toBe("מה בא לך, טרנץ' או מעיל צמר?");
  });
  for (const t of [
    "יש תקלה בהצגת הכרטיסים כרגע.",
    "לא ניתן לשלוח את הכרטיס עכשיו.",
    "Sorry, I couldn't send the carousel right now.",
    "The cards failed to load.",
  ]) it(t, () => expect(cardSendTrouble(t)).toBe(true));
  for (const t of [
    "יש טרנץ' ומעיל צמר. אפשר לבחור מידה בכרטיס.",
    "הכרטיסים למעלה, אפשר להוסיף לסל משם.",
    "There are two coats in the cards.",
  ]) it(`not: ${t}`, () => expect(cardSendTrouble(t)).toBe(false));
});

describe("\"below\"", () => {
  it("with nothing below: the word goes, the sentence stays", () => {
    expect(pointsToCardsBelow("ראיתי שני מעילים למטה, טרנץ' קליל או מעיל צמר.")).toBe(true);
    expect(dropBelow("ראיתי שני מעילים למטה, טרנץ' קליל או מעיל צמר.")).toBe("ראיתי שני מעילים, טרנץ' קליל או מעיל צמר.");
    expect(dropBelow("The two coats below are in stock.")).toBe("The two coats are in stock.");
  });
  it("a reply that points below gets the cards, named or not (T2)", () => {
    const candidates = [
      { productId: "41", title: "Cotton Trench Coat", price: "799", currency: "ILS", available: true },
      { productId: "42", title: "Wool Blend Overcoat", price: "899", currency: "ILS", available: true },
    ] as any[];
    const base = {
      unnamedAllowed: false, noCards: false, unnamedMax: 1, envelope: { status: "ok", provider: "woocommerce", candidates } as any,
      channelSupportsCards: true, alreadyStaged: false, locale: "he" as const, budget: null as any, maxProducts: 5,
    };
    const pointed = planAutoRecommendation({ ...base, modelText: "יש טרנץ' קליל ומעיל צמר חם למטה. איזה סגנון מתאים יותר?" } as any);
    expect(pointed.shouldSendStructured).toBe(true);
    expect(pointed.selected.map((c: any) => c.productId)).toEqual(["41", "42"]);
    const plain = planAutoRecommendation({ ...base, modelText: "יש טרנץ' קליל ומעיל צמר חם. איזה סגנון מתאים יותר?" } as any);
    expect(plain.shouldSendStructured).toBe(false);
    const complaint = planAutoRecommendation({ ...base, noCards: true, modelText: "המעילים למטה." } as any);
    expect(complaint.shouldSendStructured).toBe(false);
  });
});

describe("wired", () => {
  const src = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
  it("after the card step: the trouble guard (resend the last cards) and the \"below\" guard", () => {
    expect(src).toContain("cardSendTrouble(replyText)");
    expect(src).toContain("wooTurn.sendShopifyProducts({ products: last.map((p) => ({ productId: p.productId })) })");
    expect(src).toContain("pointsToCardsBelow(replyText) && !(productTurn?.staged.length)");
  });
});
