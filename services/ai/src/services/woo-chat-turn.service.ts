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
import { recentlyListedWooProduct } from "./connectors/woo-listed-products";
import { pagePriceFor, priceString, wholePercentOff } from "./woo-rendered-price.service";
import { connectedWooStore } from "./website-widget.service";
import { resolveWooCurrency } from "./discovery-integration.service";
import type { ProductMessageRecord } from "./shopify-commerce-message.service";
import { listActivePromotions, type WidgetPromotion } from "./widget-promotions.service";
import { askedColours } from "./reply-style-check.service";

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
  // Listed by the store in the last two minutes: that listing, not one more read.
  let raw: any = recentlyListedWooProduct(storeUrl, productId);
  if (!raw) {
    const got = await executeAdapterTool({ tenantId, toolFunctionName: "woocommerce.get_product", args: { product_id: productId }, accessScope: "internal" });
    if (!got.ok) return null;
    raw = got.result;
  }
  let variations: any[] | null = null;
  if (raw?.type === "variable") {
    const v = await executeAdapterTool({ tenantId, toolFunctionName: "woocommerce.list_product_variations", args: { product_id: productId, per_page: 30 }, accessScope: "internal" });
    variations = v.ok && Array.isArray(v.result) ? (v.result as any[]) : [];
  }
  const card = buildWooProductCard(raw, variations, { storeUrl, currency, reason });
  // A store discount the API does not carry (Smoovee: ₪262 → ₪170.30 from a
  // discount-rules plugin): the page's price, with the old one struck through.
  // Variants get it only when they all sell at the price that was discounted.
  if (card && !card.compareAtPrice) {
    const page = await pagePriceFor(raw, card.productUrl).catch(() => ({ state: "none" as const }));
    // A rules store whose page could not be read: no number on the card, the
    // link to the site's price instead (the API price may be the full one
    // during a sale: Smoovee 11-14 21:26).
    if (page.state === "unknown") {
      card.price = null;
      card.compareAtPrice = null;
      card.priceOnSite = true;
      card.variants = card.variants.map((v) => ({ ...v, price: null, compareAtPrice: null }));
      return card;
    }
    const d = page.state === "discount" ? page.discount : null;
    if (d) {
      const was = priceString(d.was), now = priceString(d.now);
      card.price = now;
      card.compareAtPrice = was;
      if (card.variants.length && card.variants.every((v) => Number(v.price) === d.was)) {
        card.variants = card.variants.map((v) => ({ ...v, price: now, compareAtPrice: was }));
      } else {
        // Variants at other prices (Smoovee Alexa: white 227, bamboo 237):
        // the widget shows the picked variant's price, so a variant left at
        // its full price jumps the card from ₪147.55 back to ₪227. A rule
        // that takes a whole percent off (awdr: 35%) is the same on every
        // variant; a fixed-amount rule is not, and then the variants stay.
        const off = wholePercentOff(d.was, d.now);
        if (off != null) {
          card.variants = card.variants.map((v) => {
            const full = Number(v.price);
            if (v.compareAtPrice || !Number.isFinite(full) || full <= 0) return v;
            const sale = Math.round(full * (100 - off)) / 100;
            return { ...v, price: priceString(sale), compareAtPrice: v.price };
          });
        }
      }
    }
  }
  return card;
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
    // One store read at a time (Tehila 2026-11-04: two parallel reads at
    // 05:38 and 07:10 both took 24-30s on her shared host).
    const pools: Awaited<ReturnType<typeof read>>[] = [];
    for (const category of accessories.slice(0, 2)) pools.push(await read("woocommerce.list_products", { category, in_stock: true, per_page: 20 }));
    if (!accessoryAnchor) pools.push(await read("woocommerce.list_products", { in_stock: true, per_page: 50 }));
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
// press Add to cart on a card. Then one line, "עוד מוצרים שיכולים להתאים לך:"
// (Omer 2026-11-10; it was "זה הולך מצוין עם:"), and the
// store's add-ons as cards. Once per product, across both signals; only while
// the widget's toggle is on and the bot has the conversation; nothing when the
// store has no add-ons; never a product the customer already chose.

export const CROSS_SELL_TTL_SECONDS = 60 * 60 * 24 * 30;
const crossSellKey = (conversationId: string, anchorId: string) => `woo:cross-sell:${conversationId}:${anchorId}`;
const crossSellChosenKey = (conversationId: string) => `woo:cross-sell-chosen:${conversationId}`;

/** The line over the add-on cards. */
export function goesWellWithLine(locale: string): string {
  return locale?.startsWith("he") ? "עוד מוצרים שיכולים להתאים לך:" : "More products that may suit you:";
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
 * 2026-10-28): "ראיתי שהוספת לסל את תיק הצד! עוד מוצרים שיכולים להתאים לך:". The
 * generic line when the title has no safe Hebrew name.
 */
export function addedToCartLine(locale: string, title: string | null | undefined): string {
  const t = String(title ?? "").trim();
  if (!locale?.startsWith("he")) return t ? `I see you added the ${t} to your cart! ${goesWellWithLine(locale)}` : goesWellWithLine(locale);
  const hit = HEBREW_NAME.find(([re]) => re.test(t.toLowerCase()));
  if (!hit) return goesWellWithLine(locale);
  const [, name] = hit;
  return `ראיתי שהוספת לסל את ${name}! ${goesWellWithLine(locale)}`;
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

/** Who the conversation is shopping for now: the last person the customer named, this message included; null when none. */
export function conversationAudience(
  messages: Array<{ direction?: string | null; body?: string | null }>,
  incoming?: string | null,
): "men" | "women" | null {
  return audienceWhenShown([...messages, { direction: "INBOUND", body: incoming ?? "" }], "");
}

// A kind of product in Hebrew; a material ("כותנה") refines, it is not a new kind.
const PRODUCT_KIND_HE = /סוודר|סריג|קרדיגן|חולצ|טישירט|טי-שירט|גופי|מעיל|ז'קט|ג'קט|שמל|חצאית|מכנס|ג'ינס|צעיף|צעיפ|כובע|תיק|גרב|נעל|קפוצ'ון|הודי|טרנץ'|ארנק|חגור/;

/**
 * The colour a refinement keeps (urban-e32 U5: "יש לכם חולצה לבנה?", then
 * "משהו מכותנה" was searched as "Shirts" and came back as hoodies with no
 * white). The colour of the last message that named a kind, when this one
 * names no kind and no colour, and the query has none. Null otherwise.
 */
export function carriedColour(
  messages: Array<{ direction?: string | null; body?: string | null }>,
  incoming: string | null | undefined,
  query: unknown,
): string | null {
  const now = String(incoming ?? "");
  if (askedColours(now).length || PRODUCT_KIND_HE.test(now) || askedColours(String(query ?? "")).length) return null;
  const earlier = messages.filter((m) => m.direction === "INBOUND").map((m) => String(m.body ?? ""));
  if (earlier.length && earlier[earlier.length - 1] === now) earlier.pop();
  for (let i = earlier.length - 1; i >= 0; i--) {
    const colours = askedColours(earlier[i]);
    if (PRODUCT_KIND_HE.test(earlier[i])) return colours[0] ?? null;
    if (colours.length) return colours[0];
  }
  return null;
}

/**
 * The customer's own words, for one retry of an empty product search (Smoovee
 * prod 2026-11-08, cmw7p00cq: "דגם לתמי 4", then "כן", was searched as
 * "plate", and found nothing; the store lists what fits "תמי 4" in its copy).
 * The incoming message, with the one before it when this one is a short reply
 * ("כן"). Null when those words are the model's query already, or name nothing.
 */
export function customerSearchQuery(
  messages: Array<{ direction?: string | null; body?: string | null }>,
  incoming: string | null | undefined,
  modelQuery: unknown,
): string | null {
  const now = String(incoming ?? "").trim();
  const words = (t: string) => t.toLowerCase().match(/[a-z\u0590-\u05ff]{3,}|\d+/g) ?? [];
  // A message that is only a greeting or an acknowledgement names no item: never part of the search ("היי" then
  // "דגם לתמי 4" then "כן" searches "דגם לתמי 4 כן", never "היי דגם לתמי 4 כן").
  const bare = (t: string) => /^(?:היי|הי|שלום|אהלן|הלו|בוקר\s+טוב|ערב\s+טוב|תודה(?:\s+רבה)?|כן|לא|אוקיי?|סבבה|hi|hey|hello|thanks|thank\s+you|yes|no|ok(?:ay)?)[\s!.?,]*$/iu.test(t);
  const earlier = messages.filter((m) => m.direction === "INBOUND").map((m) => String(m.body ?? "").trim()).filter(Boolean);
  if (earlier.length && earlier[earlier.length - 1] === now) earlier.pop();
  for (let i = earlier.length - 1; i >= 0; i--) if (bare(earlier[i]!)) earlier.splice(i, 1);
  const parts = [now];
  // A short follow-up ("בצבע שחור") carries the item from before it: the last message, and the one before
  // when this one is very short (rating 657e5f85, Tehila: "בובון" two messages back was never searched).
  const own = words(now).filter((w) => !/^\d+$/.test(w)).length;
  if (own < 3 && earlier.length) parts.unshift(earlier[earlier.length - 1]!);
  if (own < 2 && earlier.length > 1) parts.unshift(earlier[earlier.length - 2]!);
  const q = parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 120);
  const mine = new Set(words(String(modelQuery ?? "")));
  const theirs = words(q);
  if (!theirs.some((w) => !/^\d+$/.test(w)) || theirs.every((w) => mine.has(w))) return null;
  return q;
}

// A Hebrew word for a whole kind, its store category and the title word to rank by.
const BROAD_KIND: Array<[RegExp, string, string]> = [
  [/(?<![\u0590-\u05FF])[ובלהש]?(?:מעיל|מעילים)(?![\u0590-\u05FF])/u, "coats", "coat"],
];

/**
 * "מעיל" is every coat and jacket (urban replay 2026-10-28: "ויש מעיל לגברים ?"
 * searched "Jacket" and the overcoat was ranked out): the store's category,
 * ranked by "coat" and whatever else the query says ("wool"). Only when this
 * message names the kind and the model's query is that kind in general; a
 * specific product ("trench coat", "טרנץ'") stays the model's search.
 */
export function broadKind(incoming: string | null | undefined, query: unknown): { kind: string; rank: string } | null {
  const t = String(incoming ?? "");
  const q = String(query ?? "").toLowerCase().trim();
  if (/טרנץ'|trench/i.test(t) || !/^(?:[a-z]+ )?(?:coats?|jackets?|overcoats?)$/.test(q)) return null;
  for (const [re, kind, word] of BROAD_KIND) {
    if (re.test(t)) return { kind, rank: [q.replace(/\b(?:over)?coats?\b|\bjackets?\b/g, "").trim(), word].filter(Boolean).join(" ") };
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
  return /קופון|קוד|הנחה|מבצע|החזר|החזרה|להחזיר|החלפה|להחליף|מדיניות|תשלום|תשלומים|לשלם|ביט|אשראי|פייפאל|משלוח|משלוחים|חינם|אספקה|יגיע|יגיעו|שליח|איסוף|שעות|פתוחים|כתובת|סניף|חנות פיזית|למדוד|לכבס|כביסה|כיבסתי|יום הולדת|הזמנה|הזמנתי|coupon|discount|promo|refund|return|exchange|shipping|\bship\b|courier|pick ?up|delivery|payment|installments|hours|address|store location/i.test(t);
}

/**
 * A question about getting the order: shipping, delivery, a courier, pickup,
 * how long it takes (Tehila 2026-11-05 15:38: "וכמה עולה שליח עד הבית" ran a
 * product search and was answered with three scarves). Never a product search,
 * unless the message also names a product.
 */
export function shippingQuestion(text: string | null | undefined): boolean {
  const t = String(text ?? "");
  if (namesProduct(t)) return false;
  return /שליח|משלוח|משלוחים|לשלוח|ישלחו|אספקה|יגיע|יגיעו|זמן הגעה|איסוף|לאסוף|נקודת חלוקה|דואר|delivery|deliver|shipping|ship|courier|pick ?up/i.test(t);
}

/**
 * A base size the customer gave ("הבסיס 40 על 20", "40x20 ס\"מ"), in cm: this
 * message's, or the one before when this one is a short reply. Null otherwise.
 */
export function baseSizeAsked(
  messages: Array<{ direction?: string | null; body?: string | null }>,
  incoming: string | null | undefined,
): [number, number] | null {
  const read = (t: string): [number, number] | null => {
    const m = /(\d{1,3}(?:[.,]\d)?)\s*(?:ס["״']?מ|cm)?\s*(?:[x×*]|על|by)\s*(\d{1,3}(?:[.,]\d)?)/i.exec(t);
    if (!m) return null;
    const a = Number(m[1].replace(",", ".")), b = Number(m[2].replace(",", "."));
    return a > 0 && b > 0 && a < 300 && b < 300 ? [a, b] : null;
  };
  const now = String(incoming ?? "");
  const hit = read(now);
  if (hit) return hit;
  if (now.trim().length > 12) return null;
  const earlier = messages.filter((m) => m.direction === "INBOUND").map((m) => String(m.body ?? ""));
  if (earlier.length && earlier[earlier.length - 1] === now) earlier.pop();
  return earlier.length ? read(earlier[earlier.length - 1]) : null;
}

/**
 * Every base size the customer gave, in cm, in order (Smoovee prod 2026-11-14
 * 21:25: "מג'ימיקס 21x24 סמ', מיקסר 22x35 סמ'" was read as 21 x 24 alone, and
 * all five mats came back). This message's, or the one before when this one
 * is a short reply. Empty when none.
 */
export function baseSizesAsked(
  messages: Array<{ direction?: string | null; body?: string | null }>,
  incoming: string | null | undefined,
): Array<[number, number]> {
  const re = /(\d{1,3}(?:[.,]\d)?)\s*(?:ס["״']?מ|cm)?\s*(?:[x×*]|על|by)\s*(\d{1,3}(?:[.,]\d)?)/gi;
  const read = (t: string): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    for (const m of t.matchAll(re)) {
      const a = Number(m[1].replace(",", ".")), b = Number(m[2].replace(",", "."));
      if (a > 0 && b > 0 && a < 300 && b < 300 && !out.some(([x, y]) => x === a && y === b)) out.push([a, b]);
    }
    return out.slice(0, 4);
  };
  const now = String(incoming ?? "");
  const hit = read(now);
  if (hit.length) return hit;
  if (now.trim().length > 12) return [];
  const earlier = messages.filter((m) => m.direction === "INBOUND").map((m) => String(m.body ?? ""));
  if (earlier.length && earlier[earlier.length - 1] === now) earlier.pop();
  return earlier.length ? read(earlier[earlier.length - 1]) : [];
}

/**
 * A message asking the store for a product, a fit or what is in stock, in any
 * words (Smoovee prod 2026-11-08, cmw7ugbvb: "ומה יש לכם לתמי 4" and "נגיד
 * 20*40" were answered from the knowledge text, with no search and no card,
 * and wrongly). Not a store question (shipping, returns, a coupon).
 */
export function storeProductAsk(
  messages: Array<{ direction?: string | null; body?: string | null }>,
  incoming: string | null | undefined,
): boolean {
  const t = String(incoming ?? "");
  if (storeQuestion(t) || shippingQuestion(t)) return false;
  if (baseSizeAsked(messages, t)) return true;
  return namesProduct(t) || /מה יש לכם|יש לכם|יש לך|מתאים|מתאימה|איזה משטח|איזה דגם|איזו|תואם|מחפש|מחפשת|צריך|צריכה|דגם|מוצר|במלאי|ממליצ|תמליצ|המלצה|do you have|what fits|fits? (?:a|my|the)|looking for|recommend|in stock/i.test(t);
}

/**
 * A support turn, not a shopping one (Demo Factory 2026-11-10: "התקנתי את
 * הסוויצ'ר והאפליקציה לא מוצאת אותו" got good troubleshooting, then a
 * five-product carousel from the pre-search). A technical problem, setting
 * something up, an order's status, a return or a cancellation: the store is
 * not searched before the model writes, and nothing presses it to search.
 * The model may still search when the customer asks for a product.
 */
const SUPPORT_TURN = new RegExp([
  // Hebrew: it does not work / a fault / setting up / connecting
  "לא עובד", "לא עובדת", "לא מתחבר", "לא מתחברת", "לא נדלק", "לא נדלקת", "לא מוצא(?:ת)? אות", "לא מזהה", "לא מגיב", "לא מגיבה",
  "תקלה", "תקול", "שגיאה", "נתקע", "נתקעה", "הפסיק", "הפסיקה", "התקנתי", "להתקין", "התקנה", "הגדרתי", "להגדיר", "חיברתי", "לחבר את", "איפוס", "לאפס",
  "אפליקציה", "האפליקציה", "בלוטות", "וויי.?פיי", "wifi",
  // Hebrew: my order, delivery, return, cancel, warranty
  "ההזמנה שלי", "מספר הזמנה", "איפה ההזמנה", "מה עם ההזמנה", "לא הגיע", "לא הגיעה", "המשלוח שלי", "מעקב", "החזרה", "להחזיר", "החזר כספי", "זיכוי", "לבטל", "ביטול", "אחריות", "פגום", "פגומה", "שבור", "שבורה",
  // English
  "not working", "doesn'?t work", "does not work", "won'?t (?:turn on|connect|pair)", "can'?t (?:connect|pair|find it)", "broken", "error", "troubleshoot", "set ?up", "install(?:ed|ing)?", "pair(?:ed|ing)?", "reset",
  "my order", "order status", "where is my", "tracking", "refund", "return(?:ed|ing)? (?:it|my|the)", "cancel", "warranty", "defective", "damaged",
].join("|"), "i");

export function supportTurn(text: string | null | undefined): boolean {
  return SUPPORT_TURN.test(String(text ?? ""));
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
