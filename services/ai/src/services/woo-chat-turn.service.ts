/**
 * The website widget's product cards from the connected WooCommerce store
 * (W9 phase b, 2026-10-14): the web chat's counterpart of
 * shopify-chat-turn.service.
 *
 * Offered only on a WEBCHAT conversation whose widget has products turned on
 * (opt-in) while the workspace's WooCommerce store is connected. Every
 * product is re-read from the store before it becomes a card: the model only
 * names an id, never a title, price or link, so it cannot invent a product.
 * Cards are STAGED and written after the text reply, like Shopify's.
 */
import {
  prisma,
  getRedis,
  publishEvent,
  visitorLocaleOf,
  normalizeWebchatConfig,
  buildWooProductCard,
  summarizeWooCards,
  WOO_MESSAGE_TYPES,
  MAX_CAROUSEL_ITEMS,
  type SendShopifyProductsArgs,
  type SendShopifyProductsResult,
  type WooCommercePayload,
  type WooProductCard,
} from "@chatcenter/shared";
import { executeAdapterTool } from "./connectors/integration-framework";
import { connectedWooStore } from "./website-widget.service";
import { resolveWooCurrency } from "./discovery-integration.service";
import type { ProductMessageRecord } from "./shopify-commerce-message.service";
import { listActivePromotions, type WidgetPromotion } from "./widget-promotions.service";

export interface WooTurn {
  provider: "woocommerce";
  storeUrl: string;
  channelAccountId: string;
  productMessagingEnabled: true;
  /** The widget's "suggest complementary products" (commerce.suggestComplementary). */
  suggestComplementary: boolean;
  addToCartEnabled: boolean;
  carouselSize: number;
  staged: ProductMessageRecord[];
  /** The products this conversation's cards showed (store id, slug, title), newest last. */
  shown: ShownProduct[];
  sendShopifyProducts: (args: SendShopifyProductsArgs) => Promise<SendShopifyProductsResult>;
}

/** Null for every conversation that is not a web chat with Woo products on. */
export async function prepareWebchatCommerceTurn(opts: { tenantId: string; conversationId: string }): Promise<WooTurn | null> {
  const conv = await prisma.conversation.findFirst({
    where: { id: opts.conversationId, tenantId: opts.tenantId },
    select: { channel: true, channelAccountId: true },
  });
  if (!conv || conv.channel !== ("WEBCHAT" as any) || !conv.channelAccountId) return null;
  const account = await prisma.channelAccount.findFirst({
    where: { id: conv.channelAccountId, tenantId: opts.tenantId, channel: "WEBCHAT" as any },
    select: { id: true, credentials: true },
  });
  if (!account) return null;
  const config = normalizeWebchatConfig(account.credentials);
  if (!config.commerce.productMessagingEnabled) return null;
  const store = await connectedWooStore(opts.tenantId);
  if (!store) return null;

  const turn: WooTurn = {
    provider: "woocommerce",
    storeUrl: store.storeUrl,
    channelAccountId: account.id,
    productMessagingEnabled: true,
    suggestComplementary: config.commerce.suggestComplementary,
    addToCartEnabled: config.commerce.addToCartEnabled,
    carouselSize: MAX_CAROUSEL_ITEMS,
    staged: [],
    shown: await shownProducts(opts.tenantId, opts.conversationId),
    sendShopifyProducts: async () => ({ ok: false, reason: "not_ready" }),
  };
  turn.sendShopifyProducts = (args) => stageWooProducts(turn, opts.tenantId, config.commerce.addToCartEnabled, args);
  return turn;
}

async function readCard(tenantId: string, storeUrl: string, currency: string | null, productId: string, reason: string | null): Promise<WooProductCard | null> {
  const got = await executeAdapterTool({ tenantId, toolFunctionName: "woocommerce.get_product", args: { product_id: productId }, accessScope: "internal" });
  if (!got.ok) return null;
  const raw: any = got.result;
  let variations: any[] | null = null;
  if (raw?.type === "variable") {
    const v = await executeAdapterTool({ tenantId, toolFunctionName: "woocommerce.list_product_variations", args: { product_id: productId, per_page: 30 }, accessScope: "internal" });
    variations = v.ok && Array.isArray(v.result) ? (v.result as any[]) : [];
  }
  return buildWooProductCard(raw, variations, { storeUrl, currency, reason });
}

/** batch: which card message showed it (products of one carousel share it). */
export interface ShownProduct { productId: string; handle: string | null; title: string; batch: number }

/** The products the conversation's card messages showed, oldest first. */
export async function shownProducts(tenantId: string, conversationId: string): Promise<ShownProduct[]> {
  const rows = await prisma.message.findMany({
    where: { tenantId, conversationId, direction: "OUTBOUND", messageType: { contains: "product" } },
    orderBy: { createdAt: "asc" },
    take: 50,
    select: { metadata: true },
  }).catch(() => []);
  const out: ShownProduct[] = [];
  for (const [batch, r] of rows.entries()) {
    const products = (r.metadata as any)?.commerce?.products;
    for (const p of Array.isArray(products) ? products : []) {
      if (!/^\d{1,12}$/.test(String(p?.productId ?? ""))) continue;
      out.push({ productId: String(p.productId), handle: typeof p.handle === "string" ? p.handle : null, title: String(p.title ?? ""), batch });
    }
  }
  return out;
}

const slugOf = (v: string) => v.trim().toLowerCase().replace(/['’"]/g, "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");

/**
 * The store id a card reference names (dev 2026-10-26, conv cmvpghp1…: "שלח לי"
 * after cards were shown; the model passed handle "cotton-trench-coat", the
 * history shows cards by title only, and the carousel failed). An id as it is;
 * else a handle, slug or title the conversation's cards showed; else the store's
 * product with that slug. Null when nothing matches.
 */
export async function resolveWooRef(
  tenantId: string,
  shown: ShownProduct[],
  ref: { productId?: string | null; handle?: string | null },
): Promise<string | null> {
  const id = String(ref.productId ?? "").trim();
  if (/^\d{1,12}$/.test(id)) return id;
  const key = slugOf(String(ref.handle ?? "") || id);
  if (!key) return null;
  for (let i = shown.length - 1; i >= 0; i--) {
    const p = shown[i];
    if ((p.handle && slugOf(p.handle) === key) || (p.title && slugOf(p.title) === key)) return p.productId;
  }
  const got = await executeAdapterTool({ tenantId, toolFunctionName: "woocommerce.get_product", args: { slug: key }, accessScope: "internal" }).catch(() => null);
  const p: any = got?.ok ? got.result : null;
  return p && /^\d{1,12}$/.test(String(p.id ?? "")) ? String(p.id) : null;
}

/** The card message for these refs, every product re-read from the store; null when none is a published product. */
async function buildWooCards(
  tenantId: string,
  where: { storeUrl: string; channelAccountId: string; shown: ShownProduct[]; carouselSize: number },
  addToCartEnabled: boolean,
  products: SendShopifyProductsArgs["products"],
): Promise<{ record: ProductMessageRecord; cards: WooProductCard[] } | { reason: string }> {
  const resolved = await Promise.all((products ?? []).slice(0, where.carouselSize).map(async (r) => {
    const productId = await resolveWooRef(tenantId, where.shown, r ?? {});
    return productId ? { ...r, productId } : null;
  }));
  const refs = resolved.filter((r): r is NonNullable<typeof r> => !!r);
  if (!refs.length) return { reason: "no_products: pass the product_id from a search result" };
  const { currency } = await resolveWooCurrency(tenantId).catch(() => ({ currency: undefined }));
  const cards = (await Promise.all(refs.map((r) => readCard(tenantId, where.storeUrl, currency ?? null, r.productId, r.reason ?? null))))
    .filter((c): c is WooProductCard => !!c);
  if (!cards.length) return { reason: "no_matching_products: none of those ids is a published product in this store" };

  const payload: WooCommercePayload = {
    kind: "woo_commerce",
    storeUrl: where.storeUrl,
    channelAccountId: where.channelAccountId,
    products: cards,
    addToCartEnabled,
    source: "ai",
  };
  return {
    cards,
    record: {
      messageType: cards.length > 1 ? WOO_MESSAGE_TYPES.PRODUCT_CAROUSEL : WOO_MESSAGE_TYPES.PRODUCT,
      body: summarizeWooCards(cards),
      metadata: { source: "ai_bot", commerce: payload },
    },
  };
}

async function stageWooProducts(turn: WooTurn, tenantId: string, addToCartEnabled: boolean, args: SendShopifyProductsArgs): Promise<SendShopifyProductsResult> {
  const built = await buildWooCards(tenantId, turn, addToCartEnabled, args.products);
  if ("reason" in built) return { ok: false, reason: built.reason };
  turn.staged.push(built.record);
  return { ok: true, products: built.cards.map((c) => ({ title: c.title, price: c.price, currency: c.currency ?? "", available: c.available })) };
}

/** Shopify's catalogue tools: not this conversation's store on a web chat whose cards come from WooCommerce. */
export const WOO_TURN_HIDDEN_TOOLS: ReadonlySet<string> = new Set(["shopify.search_products", "shopify.get_product", "shopify.complementary_products"]);

// ─── Complementary products (2026-10-24) ─────────────────────────────────────
//
// What goes with the product the customer chose, from THIS store: its own
// cross-sells and upsells first (what the merchant linked in WooCommerce), then,
// when those are fewer than asked for, in-stock products from OTHER kinds of
// product: accessories first, then the rest, all for the same person (Men /
// Women: the conversation's, else the product's); an accessory gets only other
// accessories, never one of its own kind (a bag with a bag). Never the
// anchor's own kind (2026-10-26: urban links nothing, so the old same-category
// fill made the trench coat's add-ons other coats), never a product the customer was
// already shown. Nothing that qualifies: nothing, not substitutes. Published,
// visible and in stock only. The result has the shape of list_products, so the
// typed product path grounds it and the widget shows cards, exactly as for a
// search. Offered only while the widget's toggle is on.

export const WOO_COMPLEMENTARY_LIMIT = 4;

// The same name as shared tool-gate's WOO_COMPLEMENTARY_TOOL_NAME (a test pins
// it). A literal, not the import: this module loads in many suites whose
// shared mock has no such export, and the tool is built at import time.
const WOO_COMPLEMENTARY_TOOL_NAME = "woocommerce.complementary_products";

export const WOO_COMPLEMENTARY_TOOL = {
  type: "function" as const,
  function: {
    name: WOO_COMPLEMENTARY_TOOL_NAME,
    description:
      "Products from this store that go with one product: what the store links to it (cross-sells and upsells), " +
      "else in-stock products from its category. Returns products to show as cards.\n\n" +
      "WHEN TO USE: the customer has settled on a product you showed them (they said they will take it, asked how to order it, or added it to the cart). " +
      "Offer the add-ons once, briefly, after answering what they asked.\n\n" +
      "DO NOT USE: before the customer chose something, for a product you never showed them, or again for the same product.",
    parameters: {
      type: "object",
      properties: {
        product_id: { type: "string", description: "The numeric id of the product the customer chose, from a result you showed." },
      },
      required: ["product_id"],
      additionalProperties: false,
    },
  },
};

const idList = (v: unknown): string[] =>
  (Array.isArray(v) ? v : []).map((x) => String(x ?? "").trim()).filter((x) => /^\d{1,12}$/.test(x));
const sellable = (p: any) =>
  p && p.status === "publish" && p.catalog_visibility !== "hidden" && p.stock_status === "instock" && p.purchasable !== false;

const ACCESSORY_CATEGORY = /accessor|אקססור|אביזר/i;
// A top-level category that says who a product is for (the adapter's own list, for the audience param).
const AUDIENCE_CATEGORY: Record<"men" | "women", RegExp> = {
  men: /^(?:men|mens|men'?s|man|male|גברים|גבר)$/i,
  women: /^(?:women|womens|women'?s|woman|female|נשים|אישה)$/i,
};

/** What a product is ("Leather Crossbody Bag" -> "bag"): two accessories with the same one are substitutes. */
function headNoun(name: unknown): string {
  const words = String(name ?? "").toLowerCase().replace(/\b\d+-pack\b/g, "").match(/[a-z]+/g) ?? [];
  return (words[words.length - 1] ?? "").replace(/(?<!s)s$/, "");
}

export async function wooComplementaryProducts(
  tenantId: string,
  productId: string,
  limit = WOO_COMPLEMENTARY_LIMIT,
  opts: { exclude?: string[]; audience?: "men" | "women" | null } = {},
): Promise<{ ok: true; result: any[]; anchorName: string; sources: { linked: number; otherKinds: number } } | { ok: false; reason: string }> {
  const id = String(productId ?? "").trim();
  if (!/^\d{1,12}$/.test(id)) return { ok: false, reason: "complementary_products needs the numeric product_id of the product the customer chose." };
  const read = (toolFunctionName: string, args: Record<string, unknown>) =>
    executeAdapterTool({ tenantId, toolFunctionName, args, accessScope: "internal" });

  const anchor = await read("woocommerce.get_product", { product_id: id });
  if (!anchor.ok) return { ok: false, reason: `product ${id} is not in this store` };
  const raw: any = anchor.result;
  const excluded = new Set([id, ...idList(opts.exclude)]);

  const linkedIds = [...new Set([...idList(raw?.cross_sell_ids), ...idList(raw?.upsell_ids)])].filter((x) => !excluded.has(x));
  let linked: any[] = [];
  if (linkedIds.length) {
    const got = await read("woocommerce.list_products", { include: linkedIds, in_stock: true, per_page: Math.min(100, linkedIds.length) });
    // Keep the merchant's order (cross-sells first), not the API's.
    const byId = new Map((got.ok && Array.isArray(got.result) ? (got.result as any[]) : []).filter(sellable).map((p) => [String(p.id), p]));
    linked = linkedIds.map((x) => byId.get(x)).filter(Boolean).slice(0, limit);
  }

  let otherKinds: any[] = [];
  const catsOf = (p: any) => idList((p?.categories ?? []).map((c: any) => c?.id));
  const anchorCats = catsOf(raw);
  if (linked.length < limit && anchorCats.length) {
    // The anchor's KIND is its categories under a parent ("Clothing > Jackets &
    // Coats"); a top-level category that cuts across kinds ("Men") is its
    // audience, a preference. Without the tree, every category of the anchor is
    // its kind: nothing from any of them.
    const cats = await read("woocommerce.list_product_categories", {});
    const tree = cats.ok && Array.isArray(cats.result) ? (cats.result as any[]) : null;
    const parentOf = new Map((tree ?? []).map((c) => [String(c?.id), String(c?.parent ?? "0")]));
    const nameOf = new Map((tree ?? []).map((c) => [String(c?.id), String(c?.name ?? "").replace(/&amp;/g, "&").trim()]));
    // A top-level "Men" / "Women" is who the product is for, never its kind
    // (Omer 2026-10-28: the crossbody bag is Accessories + Women, both top-level,
    // so Women was taken for its kind and every women's product was left out:
    // the add-ons were men's trousers).
    const audienceCat = (a: "men" | "women") =>
      (tree ?? []).filter((c) => String(c?.parent ?? "0") === "0" && AUDIENCE_CATEGORY[a].test(nameOf.get(String(c?.id)) ?? "")).map((c) => String(c.id));
    const audienceCats = { men: audienceCat("men"), women: audienceCat("women") };
    const isAudience = (c: string) => audienceCats.men.includes(c) || audienceCats.women.includes(c);
    const rest = anchorCats.filter((c) => !isAudience(c));
    const children = tree ? rest.filter((c) => (parentOf.get(c) ?? "0") !== "0") : [];
    const kind = new Set(children.length ? children : rest.length ? rest : anchorCats);
    const accessoryCats = (tree ?? []).filter((c) => ACCESSORY_CATEGORY.test(nameOf.get(String(c?.id)) ?? "")).map((c) => String(c.id));
    // An accessory goes with another accessory, never a bag with a bag; it is
    // not a reason to show clothes.
    const accessoryAnchor = [...kind].some((c) => accessoryCats.includes(c));
    const accessories = accessoryAnchor ? accessoryCats : accessoryCats.filter((c) => !kind.has(c));
    // Who the add-ons are for: the conversation's when the product is for them
    // too, else the product's own when it has one. A product for someone else
    // is never an add-on; one for no one in particular is.
    const anchorFor = (["men", "women"] as const).filter((a) => anchorCats.some((c) => audienceCats[a].includes(c)));
    const target = opts.audience && (!anchorFor.length || anchorFor.includes(opts.audience)) ? opts.audience : anchorFor.length === 1 ? anchorFor[0] : null;
    const forTarget = (p: any) => {
      if (!target) return true;
      const forWhom = catsOf(p).filter(isAudience);
      return !forWhom.length || forWhom.some((c) => audienceCats[target].includes(c));
    };
    const audience = new Set(target ? audienceCats[target] : anchorCats.filter(isAudience));
    const taken = new Set([...excluded, ...linked.map((p) => String(p.id))]);
    const pools = await Promise.all([
      ...accessories.slice(0, 2).map((category) => read("woocommerce.list_products", { category, in_stock: true, per_page: 20 })),
      ...(accessoryAnchor ? [] : [read("woocommerce.list_products", { in_stock: true, per_page: 50 })]),
    ]);
    const seen = new Set<string>();
    const pool = pools
      .flatMap((g) => (g.ok && Array.isArray(g.result) ? (g.result as any[]) : []))
      .filter((p) => (seen.has(String(p?.id)) ? false : (seen.add(String(p?.id)), true)))
      .filter(sellable)
      .filter((p) => !taken.has(String(p.id)))
      .filter(forTarget)
      // Another kind, known: a product with no category could be a substitute.
      .filter((p) => catsOf(p).length > 0 && (accessoryAnchor
        ? catsOf(p).some((c) => accessoryCats.includes(c)) && headNoun(p.name) !== headNoun(raw?.name)
        : !catsOf(p).some((c) => kind.has(c))));
    // Accessories first, then the anchor's audience, then the store's order.
    const rank = (p: any) =>
      (catsOf(p).some((c) => accessories.includes(c)) ? 0 : 2) + (audience.size && !catsOf(p).some((c) => audience.has(c)) ? 1 : 0);
    otherKinds = pool
      .map((p, i) => ({ p, i }))
      .sort((x, y) => rank(x.p) - rank(y.p) || x.i - y.i)
      .map((x) => x.p)
      .slice(0, limit - linked.length);
  }

  return { ok: true, result: [...linked, ...otherKinds], anchorName: String(raw?.name ?? ""), sources: { linked: linked.length, otherKinds: otherKinds.length } };
}

// ─── Cross-sell when the customer settles on a product (2026-10-26) ──────────
//
// The complementary tool was offered and never called (Omer's urban test: zero
// calls in 40 minutes). The model only sees text, so the moment the customer
// chooses is decided here instead: they say they will take or order it, or they
// press Add to cart on a card. Then one line, "זה הולך מצוין עם:", and the
// store's add-ons as cards. Once per product, across both signals; only while
// the widget's toggle is on and the bot has the conversation; nothing when the
// store has no add-ons; never a product the customer already chose.

export const CROSS_SELL_TTL_SECONDS = 60 * 60 * 24 * 30;
const crossSellKey = (conversationId: string, anchorId: string) => `woo:cross-sell:${conversationId}:${anchorId}`;
const crossSellChosenKey = (conversationId: string) => `woo:cross-sell-chosen:${conversationId}`;

/** The line over the add-on cards. */
export function goesWellWithLine(locale: string): string {
  return locale?.startsWith("he") ? "זה הולך מצוין עם:" : "This goes great with:";
}

// A store title's Hebrew name, with its gender for "הוא/היא הולך", most specific first.
const HEBREW_NAME: Array<[RegExp, string, "m" | "f" | "pl"]> = [
  [/\bcrossbody\b/, "תיק הצד", "m"], [/\btote\b/, "תיק הבד", "m"], [/\bbag\b/, "התיק", "m"],
  [/\bbeanie\b/, "כובע הגרב", "m"], [/\bhat\b/, "הכובע", "m"], [/\bscarf\b/, "הצעיף", "m"],
  [/\bbelt\b/, "החגורה", "f"], [/\bsocks?\b/, "הגרביים", "pl"], [/\bwallet\b/, "הארנק", "m"],
  [/\btrench\b/, "הטרנץ'", "m"], [/\b(?:over)?coat\b/, "המעיל", "m"], [/\bjacket\b/, "הז'קט", "m"],
  [/\bhoodie\b/, "הקפוצ'ון", "m"], [/\bcardigan\b/, "הקרדיגן", "m"], [/\bsweater\b/, "הסוודר", "m"],
  [/\btank top\b/, "הגופייה", "f"], [/\bovershirt\b/, "החולצה העליונה", "f"], [/\b(?:t-shirt|tee|shirt)\b/, "החולצה", "f"],
  [/\bdress\b/, "השמלה", "f"], [/\bskirt\b/, "החצאית", "f"],
  [/\b(?:pants|trousers|chinos?|jeans)\b/, "המכנסיים", "pl"],
];

/**
 * The line over the add-ons after Add to cart, naming what was added (Omer
 * 2026-10-28): "ראיתי שהוספת לסל את תיק הצד! הוא הולך מושלם עם:". The
 * generic line when the title has no safe Hebrew name.
 */
export function addedToCartLine(locale: string, title: string | null | undefined): string {
  const t = String(title ?? "").trim();
  if (!locale?.startsWith("he")) return t ? `I see you added the ${t} to your cart! It goes great with:` : goesWellWithLine(locale);
  const hit = HEBREW_NAME.find(([re]) => re.test(t.toLowerCase()));
  if (!hit) return goesWellWithLine(locale);
  const [, name, g] = hit;
  const goes = g === "m" ? "הוא הולך" : g === "f" ? "היא הולכת" : "הם הולכים";
  return `ראיתי שהוספת לסל את ${name}! ${goes} מושלם עם:`;
}

/**
 * The customer settles on a product: they will take it, order it, or added it
 * to the cart. Narrow on purpose: a question ("יש במידה M?") is not a choice,
 * and neither is a "no".
 */
export function commitsToBuy(text: string | null | undefined): boolean {
  const t = String(text ?? "").trim();
  if (!t || /[?؟]/.test(t)) return false;
  if (/(?:^|\s)(?:לא|אל|בלי)\s+(?:אקח|ניקח|לוקח|לוקחת|אזמין|נזמין|מזמין|מזמינה)|\b(?:won'?t|will not|not|don'?t)\s+(?:take|buy|order|get)\b/iu.test(t)) return false;
  return /(?:^|[\s,.!])(?:אקח|ניקח|אני לוקח|אני לוקחת|לוקח(?:ת)? (?:את|אותו|אותה|אותם)|אזמין|נזמין|אני מזמין|אני מזמינה|רוצה להזמין|רוצים להזמין|הוספתי (?:\S+ ){0,4}ל(?:סל|עגלה))(?=$|[\s,.!])|\bI(?:'ll| will) (?:take|buy|order|get) (?:it|this|that|the|one|them)\b|\bI(?:'d| would) like to order\b|\b(?:I )?added (?:it|this|that|them|the \S+(?: \S+)?) to (?:the |my )?(?:cart|basket)\b/iu.test(t);
}

/**
 * A choice and nothing else (P1, 2026-10-27): "אני לוקח את מעיל הצמר". Any
 * question or extra request in the same message ("אני לוקח, יש משלוח מהיר")
 * is not, and goes the model's way with the add-ons after the answer.
 */
export function pureChoice(text: string | null | undefined): boolean {
  const t = String(text ?? "").trim();
  if (!commitsToBuy(t) || /[?؟]/.test(t)) return false;
  if (t.split(/\s+/).length > 8) return false;
  return !/(?<![\u0590-\u05FF])[ובלהש]{0,2}(?:יש|אפשר|מתי|כמה|איך|האם|מה|איפה|למה|תשלח|תשלחו|שלח|שלחו|תוסיף|תוסיפו|תעדכן|תבדוק|תבדקו|משלוח|החזרה|החזרות|הנחה|קופון|מידה|מידות|צבע|צבעים|מהיר)(?![\u0590-\u05FF])|\b(?:is|are|can|could|when|how|what|ship|shipping|delivery|size|colou?r|discount|coupon)\b/iu.test(t);
}

/** Who a refinement says it is for, when the words say it outright; null otherwise ("בשבילי" alone says nothing). */
export function audienceOf(text: string | null | undefined): "men" | "women" | null {
  const t = String(text ?? "");
  const men = /(?<![\u0590-\u05FF])[ולבשה]{0,2}(?:גבר|גברים|בעלי|אבא|אבי)(?![\u0590-\u05FF])|\b(?:men|man|husband|dad|father)\b/iu.test(t);
  const women = /(?<![\u0590-\u05FF])[ולבשה]{0,2}(?:אישה|אשה|נשים|אשתי|אחותי|אמא|אמי)(?![\u0590-\u05FF])|\b(?:women|woman|wife|sister|mom|mother)\b/iu.test(t);
  return men === women ? null : men ? "men" : "women";
}

/** Who a message says the purchase is for: an audience, or a partner ("מתנה לבת זוגג שלי"). */
export function recipientAudienceOf(text: string | null | undefined): "men" | "women" | null {
  const t = String(text ?? "");
  const said = audienceOf(t);
  if (said) return said;
  const women = /(?<![֐-׿])[ול]?(?:בת\s+(?:ה)?זוג\S*|(?:ה)?חברה\s+שלי)|\b(?:girlfriend|wife)\b/iu.test(t);
  const men = /(?<![֐-׿])[ול]?(?:בן\s+(?:ה)?זוג\S*|(?:ה)?חבר\s+שלי)|\bboyfriend\b/iu.test(t);
  return men === women ? null : men ? "men" : "women";
}

/**
 * Who the customer was shopping for when a product was shown: the last person
 * they named before the card with it (Omer 2026-10-28: a bag shown for "בת
 * זוג", added to the cart after "מעיל לגברים", is still for her). All their
 * messages when no card shows it. Messages oldest first.
 */
export function audienceWhenShown(
  messages: Array<{ direction?: string | null; body?: string | null; metadata?: any }>,
  productId: string,
): "men" | "women" | null {
  const showedIt = (m: { direction?: string | null; metadata?: any }) =>
    m.direction === "OUTBOUND" && Array.isArray(m.metadata?.commerce?.products) &&
    m.metadata.commerce.products.some((p: any) => String(p?.productId ?? "") === productId);
  let end = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) if (showedIt(messages[i])) { end = i; break; }
  for (let i = end - 1; i >= 0; i--) {
    if (messages[i].direction !== "INBOUND") continue;
    const a = recipientAudienceOf(messages[i].body);
    if (a) return a;
  }
  return null;
}

/** A budget the message states ("עד 300", "under 300"); null when none. */
export function budgetOf(text: string | null | undefined): number | null {
  const m = /(?:עד|תקציב(?: של)?|under|up to)\s*₪?\s*(\d{2,6})/iu.exec(String(text ?? ""));
  return m ? Number(m[1]) : null;
}

/**
 * The search a re-search turn will predictably run (P2): the conversation's
 * last product search, with the audience or budget this message adds. Only on
 * "תראה לי", an audience or a budget; never when the message names another
 * product (that is a new search, the model's). Null when there is nothing to predict.
 */
export function predictedSearch(
  incoming: string | null | undefined,
  last: Record<string, unknown> | null,
  o: { showMe: boolean; namesProduct: boolean },
): Record<string, unknown> | null {
  if (!last || typeof last.query !== "string" || !last.query.trim() || o.namesProduct) return null;
  const audience = audienceOf(incoming);
  const budget = budgetOf(incoming);
  if (!o.showMe && !audience && budget == null) return null;
  return {
    query: last.query,
    per_page: typeof last.per_page === "number" ? last.per_page : 10,
    ...(last.in_stock === true ? { in_stock: true } : {}),
    ...(audience ? { audience } : typeof last.audience === "string" ? { audience: last.audience } : {}),
    ...(budget != null ? { price_max: budget } : typeof last.price_max === "number" ? { price_max: last.price_max } : {}),
  };
}

/** The arguments of this conversation's last product search, from the turn audits; null when none. */
export async function lastSearchArgs(tenantId: string, conversationId: string): Promise<Record<string, unknown> | null> {
  const rows = await prisma.auditLog.findMany({
    // The turn audit names its conversation as the target (urban-e27: matching
    // on metadata.conversationId found no row, so P2 never predicted).
    where: { tenantId, action: "ai.bot_turn", targetType: "conversation", targetId: conversationId },
    orderBy: { createdAt: "desc" },
    take: 6,
    select: { metadata: true },
  }).catch(() => [] as any[]);
  for (const r of rows as any[]) {
    const calls = Array.isArray(r?.metadata?.toolCalls) ? r.metadata.toolCalls : [];
    for (let i = calls.length - 1; i >= 0; i--) {
      if (calls[i]?.tool === "woocommerce.list_products" && calls[i]?.args && typeof calls[i].args === "object") return calls[i].args;
    }
  }
  return null;
}

const HEBREW_TITLE_WORDS: Array<[RegExp, string[]]> = [
  [/טרנץ/u, ["trench"]], [/מעיל/u, ["coat", "overcoat", "parka"]], [/צמר/u, ["wool"]], [/כותנה/u, ["cotton"]],
  [/פשתן/u, ["linen"]], [/עור/u, ["leather"]], [/סוודר|סריג/u, ["sweater", "knit", "jumper"]], [/קרדיגן/u, ["cardigan"]],
  [/חולצ/u, ["shirt", "tee", "top", "blouse"]], [/טישירט|טי-שירט/u, ["tee", "t-shirt"]], [/ג'ינס|גינס/u, ["jeans", "denim"]],
  [/מכנס/u, ["pants", "trousers", "jeans", "chinos"]], [/שמל/u, ["dress"]], [/חצאית/u, ["skirt"]], [/צעיף/u, ["scarf"]],
  [/כובע/u, ["hat", "beanie", "cap"]], [/תיק/u, ["bag", "tote"]], [/גרב/u, ["socks", "sock"]], [/קפוצ'ון|הודי/u, ["hoodie"]],
  [/ז'קט|ג'קט/u, ["jacket"]], [/נעל/u, ["shoe", "shoes", "sneakers", "boots"]],
];

function titleScore(message: string, title: string): number {
  const words = title.toLowerCase().split(/[^a-z0-9-]+/).filter((w) => w.length > 1);
  const lower = message.toLowerCase();
  let score = words.filter((w) => new RegExp(`\\b${w}\\b`).test(lower)).length;
  for (const [he, en] of HEBREW_TITLE_WORDS) if (he.test(message) && en.some((w) => words.includes(w))) score++;
  return score;
}

/**
 * Which product the customer chose: the one of the last cards their words name
 * ("אני לוקח את הטרנץ'"), else the product page they wrote from, else the last
 * cards when they were one product. Several and none named: null, no guess.
 */
export function crossSellAnchor(message: string, shown: ShownProduct[], pageProductId?: string | null): string | null {
  const page = pageProductId && /^\d{1,12}$/.test(pageProductId) ? pageProductId : null;
  if (!shown.length) return page;
  const lastBatch = shown[shown.length - 1].batch;
  const batch = [...new Map(shown.filter((p) => p.batch === lastBatch).map((p) => [p.productId, p])).values()];
  const scored = batch.map((p) => ({ p, s: titleScore(message, p.title) })).sort((a, b) => b.s - a.s);
  if (scored[0].s > 0 && scored[0].s > (scored[1]?.s ?? 0)) return scored[0].p.productId;
  if (page) return page;
  return batch.length === 1 ? batch[0].productId : null;
}

/**
 * Claims the one cross-sell for this product in this conversation. False when
 * it was already offered (by either signal, or by the model's own call).
 */
export async function claimCrossSell(conversationId: string, anchorId: string): Promise<boolean> {
  try {
    const redis = getRedis();
    const ok = await redis.set(crossSellKey(conversationId, anchorId), "1", "EX", CROSS_SELL_TTL_SECONDS, "NX");
    if (ok !== "OK") return false;
    await redis.sadd(crossSellChosenKey(conversationId), anchorId);
    await redis.expire(crossSellChosenKey(conversationId), CROSS_SELL_TTL_SECONDS);
    return true;
  } catch {
    return false; // No way to promise once: none.
  }
}

/**
 * Nothing went out after a claim (the store had no add-ons): the once is not
 * spent (dev 2026-10-27: no_add_ons, then already_offered). The product stays
 * chosen, so it is never offered as an add-on.
 */
export async function releaseCrossSell(conversationId: string, anchorId: string): Promise<void> {
  try { await getRedis().del(crossSellKey(conversationId, anchorId)); } catch { /* the key expires on its own */ }
}

/** The products the customer already chose in this conversation. */
async function chosenProducts(conversationId: string): Promise<string[]> {
  try { return await getRedis().smembers(crossSellChosenKey(conversationId)); } catch { return []; }
}

/**
 * The add-on cards for a chosen product, or null when the store has none. Every
 * product the customer chose in this conversation is left out.
 */
export async function crossSellCards(
  tenantId: string,
  conversationId: string,
  where: { storeUrl: string; channelAccountId: string; addToCartEnabled: boolean; carouselSize?: number },
  anchorId: string,
): Promise<ProductMessageRecord | null> {
  const chosen = new Set([anchorId, ...(await chosenProducts(conversationId))]);
  const shown = (await shownProducts(tenantId, conversationId)).map((p) => p.productId);
  const history = await prisma.message.findMany({
    where: { tenantId, conversationId },
    orderBy: { createdAt: "desc" },
    take: 60,
    select: { direction: true, body: true, metadata: true },
  }).catch(() => []);
  const audience = audienceWhenShown([...(history ?? [])].reverse() as any[], anchorId);
  const got = await wooComplementaryProducts(tenantId, anchorId, WOO_COMPLEMENTARY_LIMIT, { exclude: [...chosen, ...shown], audience }).catch(() => null);
  if (!got?.ok) return null;
  const ids = got.result.map((p: any) => String(p?.id ?? "")).filter((id) => /^\d{1,12}$/.test(id) && !chosen.has(id)).slice(0, WOO_COMPLEMENTARY_LIMIT);
  if (!ids.length) return null;
  const built = await buildWooCards(
    tenantId,
    { storeUrl: where.storeUrl, channelAccountId: where.channelAccountId, shown: [], carouselSize: where.carouselSize ?? MAX_CAROUSEL_ITEMS },
    where.addToCartEnabled,
    ids.map((productId) => ({ productId })),
  );
  if ("reason" in built) return null;
  built.record.metadata = { ...built.record.metadata, complementaryFor: anchorId, complementaryForName: got.anchorName };
  return built.record;
}

/** The product page the customer's latest message was written on (its store id), if any. */
export async function pageProductId(tenantId: string, conversationId: string): Promise<string | null> {
  const row = await prisma.message.findFirst({
    where: { tenantId, conversationId, direction: "INBOUND" },
    orderBy: { createdAt: "desc" },
    select: { metadata: true },
  }).catch(() => null);
  const id = (row?.metadata as any)?.storefront?.productId;
  return typeof id === "string" && /^\d{1,12}$/.test(id) ? id : null;
}

/** The bot has this conversation: open, not handed over, no person on it. */
export function withTheBot(c: { status?: string | null; isHandedOver?: boolean | null; handledBy?: string | null; assignedAgentId?: string | null } | null): boolean {
  return !!c && c.status === "OPEN" && !c.isHandedOver && c.handledBy === "ai_agent" && !c.assignedAgentId;
}

/** The tool surface without the other store's catalogue (unchanged when there is no Woo turn). */
export function withoutOtherStoreTools<T extends { function?: { name?: string } }>(tools: T[], wooTurn: WooTurn | null): T[] {
  return wooTurn ? tools.filter((t) => !WOO_TURN_HIDDEN_TOOLS.has(String(t?.function?.name ?? ""))) : tools;
}

/** Cards only from the store the search read: never a Shopify result on the Woo store, or the reverse. */
export function cardsMatchTurn(envelopeProvider: "shopify" | "woocommerce", wooTurn: WooTurn | null): boolean {
  return envelopeProvider === (wooTurn ? "woocommerce" : "shopify");
}

/**
 * The promotions the AI may mention in this conversation (W9 phase d): the
 * coupons the web chat's widget shows, live right now. Empty for every other
 * conversation, and when none are chosen or the store is not connected.
 */
export async function webchatPromotionsFor(tenantId: string, conversationId: string): Promise<WidgetPromotion[]> {
  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId },
    select: { channel: true, channelAccountId: true },
  });
  if (!conv || conv.channel !== ("WEBCHAT" as any) || !conv.channelAccountId) return [];
  const account = await prisma.channelAccount.findFirst({
    where: { id: conv.channelAccountId, tenantId, channel: "WEBCHAT" as any },
    select: { credentials: true },
  });
  const ids = account ? normalizeWebchatConfig(account.credentials).commerce.promotions.couponIds : [];
  if (!ids.length || !(await connectedWooStore(tenantId))) return [];
  return listActivePromotions(tenantId, ids);
}

/**
 * What the visitor is looking at on a WooCommerce store's site (2026-10-14):
 * the page context their latest web chat message carried (a product id, else
 * a slug: lookup keys only), resolved against the connected store, as a
 * prompt block like Shopify's "## Shopify Storefront". Undefined for every
 * other conversation, when the message carried no product, or when the store
 * has no such published product.
 */
export async function webchatStorefrontBlock(tenantId: string, conversationId: string): Promise<string | undefined> {
  const conv = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId }, select: { channel: true } });
  if (!conv || conv.channel !== ("WEBCHAT" as any)) return undefined;
  const row = await prisma.message.findFirst({
    where: { tenantId, conversationId, direction: "INBOUND" },
    orderBy: { createdAt: "desc" },
    select: { metadata: true },
  });
  const ctx = (row?.metadata as any)?.storefront;
  const productId = typeof ctx?.productId === "string" && /^\d{1,12}$/.test(ctx.productId) ? ctx.productId : null;
  const slug = typeof ctx?.productHandle === "string" && ctx.productHandle ? ctx.productHandle : null;
  if (!productId && !slug) return undefined;
  const store = await connectedWooStore(tenantId);
  if (!store) return undefined;
  // The id is the exact key; the slug only when there is no id.
  const got = await executeAdapterTool({
    tenantId,
    toolFunctionName: "woocommerce.get_product",
    args: productId ? { product_id: productId } : { slug },
    accessScope: "internal",
  });
  const p: any = got.ok ? got.result : null;
  if (!p || p.status !== "publish" || p.catalog_visibility === "hidden") {
    return ["## Store page", `Store: ${store.storeUrl}`, "They are on a product page, but that product could not be loaded from the store.", "Ask which product they mean rather than guessing."].join("\n");
  }
  const { currency } = await resolveWooCurrency(tenantId).catch(() => ({ currency: undefined }));
  const parts = [`- ${p.name}`];
  if (p.price) parts.push(`price ${p.price}${currency ? ` ${currency}` : ""}`);
  if (p.sale_price && p.regular_price && p.sale_price !== p.regular_price) parts.push(`was ${p.regular_price}`);
  parts.push(p.stock_status === "outofstock" ? "out of stock" : p.stock_status === "onbackorder" ? "on backorder" : "in stock");
  return [
    "## Store page",
    `Store: ${store.storeUrl}`,
    "The customer is currently viewing THIS product:",
    parts.join(" - "),
    `  product_id: ${p.id}`,
    "",
    'If they say "this", "it" or "this one" without naming a product, they mean the product above.',
  ].join("\n");
}

/**
 * A size / colour question whose search found exactly ONE variable product:
 * its variations, read now and attached to that same tool result, so the model
 * answers in the next round instead of spending one on list_product_variations
 * (2026-10-25: three rounds for "is the trench coat in M?"). Null when the
 * search found zero or several products, the product has no variations, or
 * the read fails; the model then reads them itself, as before.
 */
export async function singleProductVariations(
  tenantId: string,
  rawSearchContent: string,
  compact: (raw: string) => string,
): Promise<string | null> {
  let parsed: any;
  try { parsed = JSON.parse(rawSearchContent); } catch { return null; }
  const list = Array.isArray(parsed?.result) ? parsed.result : Array.isArray(parsed) ? parsed : null;
  if (!list || list.length !== 1 || list[0]?.type !== "variable" || !/^\d{1,12}$/.test(String(list[0]?.id ?? ""))) return null;
  const got = await executeAdapterTool({
    tenantId,
    toolFunctionName: "woocommerce.list_product_variations",
    args: { product_id: String(list[0].id), per_page: 50 },
    accessScope: "internal",
  }).catch(() => null);
  if (!got?.ok) return null;
  return compact(JSON.stringify({ ok: true, result: got.result }));
}

/**
 * The product the customer saw most recently, from the conversation's own card
 * messages (their metadata holds the store id). Null when no card was shown.
 */
export function lastShownProduct(rows: Array<{ direction: string; messageType?: string | null; metadata?: any }>): { productId: string; title: string } | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.direction !== "OUTBOUND" || !/product/.test(String(r.messageType ?? ""))) continue;
    const products = r.metadata?.commerce?.products;
    const p = Array.isArray(products) ? products[0] : null;
    if (p && /^\d{1,12}$/.test(String(p.productId ?? ""))) return { productId: String(p.productId), title: String(p.title ?? "") };
  }
  return null;
}

/** A customer message that asks about a size. */
export function asksSize(text: string | null | undefined): boolean {
  return /(?<![A-Za-z])(?:XXS|XS|S|M|L|XL|XXL)(?![A-Za-z])|מידה|מידות|\bsize\b/i.test(String(text ?? ""));
}

/**
 * The product mentioned most recently by us: a card (its store id), or a store
 * title named in our own text ("Canvas Tote", eval e9 W2: the tote never had a
 * card, so its colour was answered from nothing and contradicted a turn later).
 */
export function lastProductMention(rows: Array<{ direction: string; body?: string | null; messageType?: string | null; metadata?: any; senderName?: string | null; createdAt?: Date | string | null }>): { productId?: string; title: string; at?: Date } | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.direction !== "OUTBOUND") continue;
    const at = r.createdAt ? new Date(r.createdAt) : undefined;
    if (/product/.test(String(r.messageType ?? ""))) {
      const p = Array.isArray(r.metadata?.commerce?.products) ? r.metadata.commerce.products[0] : null;
      if (p && /^\d{1,12}$/.test(String(p.productId ?? ""))) return { productId: String(p.productId), title: String(p.title ?? ""), at };
      continue;
    }
    const m = String(r.body ?? "").match(/\b(?:[A-Z][a-z]+(?:[- ](?:[A-Z][a-z]+|\d+-Pack))){1,3}\b/g);
    if (m && m.length) return { title: m[m.length - 1], at };
  }
  return null;
}

/** The products a product tool returned, from its raw result: [{ productId, title }]. */
export function productsFromSearch(raw: string | null | undefined): Array<{ productId: string; title: string }> {
  try {
    const parsed = JSON.parse(String(raw ?? ""));
    if (parsed?.ok === false) return [];
    const list = Array.isArray(parsed?.result) ? parsed.result : parsed?.result && typeof parsed.result === "object" ? [parsed.result] : [];
    return list
      .filter((p: any) => /^\d{1,12}$/.test(String(p?.id ?? "")) && p?.name)
      .map((p: any) => ({ productId: String(p.id), title: String(p.name) }));
  } catch {
    return [];
  }
}

/**
 * Which product a bare "מידה L" or "בשחור?" is about (eval e11 L01: after a
 * search found only the Cotton Cable Sweater, but our reply called it "סוודר
 * כותנה", "מידה L" got the Chunky Cardigan's colours, the last English title in
 * our text). The newer of the two wins: the last search, or the last product we
 * named or showed. A search that found several, none of them the one named, is
 * no answer: null, and the model looks it up.
 */
export function pickLastProduct(
  mention: { productId?: string; title: string; at?: Date } | null,
  search: { at: Date; products: Array<{ productId: string; title: string }> } | null,
): { productId?: string; title: string } | null {
  const SAME_TURN_MS = 60_000;
  if (!search || !search.products.length) return mention;
  if (mention?.at && search.at.getTime() < mention.at.getTime() - SAME_TURN_MS) return mention;
  const named = mention ? search.products.find((p) => p.title.toLowerCase() === mention.title.toLowerCase()) : undefined;
  if (named) return named;
  if (search.products.length === 1) return search.products[0];
  return null;
}

/**
 * Does a customer message name a product or a category ("סוודר", "צעיף",
 * "Canvas Tote")? Then it is about THAT, not the product shown last (eval L01c:
 * "הכותנה נשמעת טוב, יש בנייבי?" was answered about the cardigan).
 */
export function namesProduct(text: string | null | undefined): boolean {
  const t = String(text ?? "");
  if (/\b[A-Z][a-z]+(?: [A-Z][a-z]+)+\b/.test(t)) return true;
  return /סוודר|סריג|קרדיגן|חולצ|טישירט|טי-שירט|גופי|מעיל|ז'קט|ג'קט|שמל|חצאית|מכנס|ג'ינס|צעיף|צעיפ|כובע|תיק|גרב|נעל|קפוצ'ון|הודי|טרנץ'|כותנה|צמר|פשתן|עור|ארנק|חגור|\b(?:tee|t-shirt|shirt|top|coat|jacket|dress|skirt|pants|jeans|scarf|beanie|hat|bag|tote|socks?|hoodie|sweater|cardigan|knit)\b/i.test(t);
}

/**
 * A question about the store, not about a product: a coupon, shipping, returns,
 * payment, hours or the shop itself (eval e12: "יש קוד קופון?" got three product
 * cards and no coupon). It gets the answer and no cards. A message that also
 * names a product ("יש הנחה על הסוודר?") is about that product.
 */
export function storeQuestion(text: string | null | undefined): boolean {
  const t = String(text ?? "");
  if (namesProduct(t)) return false;
  return /קופון|קוד|הנחה|מבצע|החזר|החזרה|להחזיר|החלפה|להחליף|מדיניות|תשלום|תשלומים|לשלם|ביט|אשראי|פייפאל|משלוח|משלוחים|חינם|אספקה|יגיע|יגיעו|שליח|איסוף|שעות|פתוחים|כתובת|סניף|חנות פיזית|למדוד|לכבס|כביסה|כיבסתי|יום הולדת|הזמנה|הזמנתי|coupon|discount|promo|refund|return|exchange|shipping|delivery|payment|installments|hours|address|store location/i.test(t);
}

/** A question about a product: it names one, or asks a colour or size. */
export function productQuestion(text: string | null | undefined, colours: number, size: boolean): boolean {
  return !storeQuestion(text) && (namesProduct(text) || colours > 0 || size);
}

/** Hebrew shop words and the English the store's titles use (eval L01c: "תיק בד" is a canvas tote). */
export const HEBREW_PRODUCT_GLOSSARY =
  "Hebrew to the English titles use: תיק בד = canvas tote; תיק עור = leather bag; כובע גרב = beanie; קפוצ'ון / הודי = hoodie; " +
  "סוודר / סריג = sweater, knit; קרדיגן = cardigan; גופיה = tank top; טישירט = tee, t-shirt; חולצה מכופתרת = shirt; " +
  "מכנסיים = pants; ג'ינס = jeans; שמלה = dress; חצאית = skirt; מעיל = coat; טרנץ' = trench coat; ז'קט = jacket; צעיף = scarf; גרביים = socks. " +
  // The other way, for describing a card in Hebrew: never transliterate a title
  // word ("כובע צמר ריב", "ליימבוול", urban-e25/e26).
  "In Hebrew say: ribbed = בסריגת צלעות; lambswool = צמר כבשים רך; cropped = קצר; overshirt = חולצה עליונה; hoodie = קפוצ'ון; beanie = כובע גרב; crossbody bag = תיק צד; tote = תיק בד. Never write an English title word in Hebrew letters.";

/**
 * Add to cart on a card (2a ii): the store checked the line, so the shopper
 * chose this product. One line and the add-on cards, written as the bot's own
 * messages through the normal outbound shape (the inbox sees them; message:new
 * reaches the widget over its socket, the poll picks them up otherwise). No
 * customer message, no model. Returns what happened, for the log.
 */
export async function offerCrossSellAfterCart(o: { tenantId: string; conversationId: string; productId: string }): Promise<string> {
  const conv = await prisma.conversation.findFirst({
    where: { id: o.conversationId, tenantId: o.tenantId },
    select: { channel: true, channelAccountId: true, status: true, isHandedOver: true, handledBy: true, assignedAgentId: true },
  });
  if (!conv || conv.channel !== ("WEBCHAT" as any) || !conv.channelAccountId) return "not_web_chat";
  if (!withTheBot(conv as any)) return "not_with_the_bot";
  const account = await prisma.channelAccount.findFirst({
    where: { id: conv.channelAccountId, tenantId: o.tenantId, channel: "WEBCHAT" as any },
    select: { credentials: true },
  });
  if (!account) return "no_widget";
  const config = normalizeWebchatConfig(account.credentials);
  if (!config.commerce.productMessagingEnabled || !config.commerce.suggestComplementary) return "toggle_off";
  const store = await connectedWooStore(o.tenantId);
  if (!store) return "no_store";
  if (!(await claimCrossSell(o.conversationId, o.productId))) return "already_offered";
  const record = await crossSellCards(o.tenantId, o.conversationId, {
    storeUrl: store.storeUrl, channelAccountId: conv.channelAccountId, addToCartEnabled: config.commerce.addToCartEnabled,
  }, o.productId).catch(() => null);
  if (!record) {
    await releaseCrossSell(o.conversationId, o.productId);
    return "no_add_ons";
  }

  const lastInbound = await prisma.message.findFirst({
    where: { tenantId: o.tenantId, conversationId: o.conversationId, direction: "INBOUND" },
    orderBy: { createdAt: "desc" },
    select: { body: true },
  });
  const language = config.appearance.language;
  const locale = visitorLocaleOf(lastInbound?.body) ?? (language === "auto" ? "he" : language);
  const rows = [
    { body: addedToCartLine(locale, (record.metadata as any)?.complementaryForName), messageType: "text", metadata: { source: "ai_bot", crossSell: { trigger: "add_to_cart", anchor: o.productId } } },
    { body: record.body, messageType: record.messageType, metadata: record.metadata },
  ];
  for (const r of rows) {
    const message = await prisma.message.create({
      data: {
        tenantId: o.tenantId,
        conversationId: o.conversationId,
        channel: "WEBCHAT" as any,
        direction: "OUTBOUND",
        body: r.body,
        messageType: r.messageType,
        senderName: "AI Bot",
        status: "SENT",
        metadata: r.metadata as any,
      },
    });
    await prisma.conversation.update({ where: { id: o.conversationId }, data: { lastMessageAt: message.createdAt } });
    await publishEvent({ event: "message:new", tenantId: o.tenantId, data: { message, conversationId: o.conversationId, channel: "WEBCHAT" } });
  }
  return "sent";
}
