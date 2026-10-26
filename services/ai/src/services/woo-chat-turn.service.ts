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
  carouselSize: number;
  staged: ProductMessageRecord[];
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
    carouselSize: MAX_CAROUSEL_ITEMS,
    staged: [],
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

async function stageWooProducts(turn: WooTurn, tenantId: string, addToCartEnabled: boolean, args: SendShopifyProductsArgs): Promise<SendShopifyProductsResult> {
  const refs = (args.products ?? [])
    .filter((r) => typeof r?.productId === "string" && /^\d{1,12}$/.test(r.productId.trim()))
    .slice(0, turn.carouselSize);
  if (!refs.length) return { ok: false, reason: "no_products: pass the store's numeric product ids" };
  const { currency } = await resolveWooCurrency(tenantId).catch(() => ({ currency: undefined }));
  const cards = (await Promise.all(refs.map((r) => readCard(tenantId, turn.storeUrl, currency ?? null, r.productId!.trim(), r.reason ?? null))))
    .filter((c): c is WooProductCard => !!c);
  if (!cards.length) return { ok: false, reason: "no_matching_products: none of those ids is a published product in this store" };

  const payload: WooCommercePayload = {
    kind: "woo_commerce",
    storeUrl: turn.storeUrl,
    channelAccountId: turn.channelAccountId,
    products: cards,
    addToCartEnabled,
    source: "ai",
  };
  turn.staged.push({
    messageType: cards.length > 1 ? WOO_MESSAGE_TYPES.PRODUCT_CAROUSEL : WOO_MESSAGE_TYPES.PRODUCT,
    body: summarizeWooCards(cards),
    metadata: { source: "ai_bot", commerce: payload },
  });
  return { ok: true, products: cards.map((c) => ({ title: c.title, price: c.price, currency: c.currency ?? "", available: c.available })) };
}

/** Shopify's catalogue tools: not this conversation's store on a web chat whose cards come from WooCommerce. */
export const WOO_TURN_HIDDEN_TOOLS: ReadonlySet<string> = new Set(["shopify.search_products", "shopify.get_product", "shopify.complementary_products"]);

// ─── Complementary products (2026-10-24) ─────────────────────────────────────
//
// What goes with the product the customer chose, from THIS store: its own
// cross-sells and upsells first (what the merchant linked in WooCommerce), then,
// when those are fewer than asked for, in-stock products from the same
// category. Published, visible and in stock only. The result has the shape of
// list_products, so the typed product path grounds it and the widget shows
// cards, exactly as for a search. Offered only while the widget's toggle is on.

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

export async function wooComplementaryProducts(
  tenantId: string,
  productId: string,
  limit = WOO_COMPLEMENTARY_LIMIT,
): Promise<{ ok: true; result: any[]; sources: { linked: number; sameCategory: number } } | { ok: false; reason: string }> {
  const id = String(productId ?? "").trim();
  if (!/^\d{1,12}$/.test(id)) return { ok: false, reason: "complementary_products needs the numeric product_id of the product the customer chose." };
  const read = (toolFunctionName: string, args: Record<string, unknown>) =>
    executeAdapterTool({ tenantId, toolFunctionName, args, accessScope: "internal" });

  const anchor = await read("woocommerce.get_product", { product_id: id });
  if (!anchor.ok) return { ok: false, reason: `product ${id} is not in this store` };
  const raw: any = anchor.result;

  const linkedIds = [...new Set([...idList(raw?.cross_sell_ids), ...idList(raw?.upsell_ids)])].filter((x) => x !== id);
  let linked: any[] = [];
  if (linkedIds.length) {
    const got = await read("woocommerce.list_products", { include: linkedIds, in_stock: true, per_page: Math.min(100, linkedIds.length) });
    // Keep the merchant's order (cross-sells first), not the API's.
    const byId = new Map((got.ok && Array.isArray(got.result) ? (got.result as any[]) : []).filter(sellable).map((p) => [String(p.id), p]));
    linked = linkedIds.map((x) => byId.get(x)).filter(Boolean).slice(0, limit);
  }

  let sameCategory: any[] = [];
  const category = idList((raw?.categories ?? []).map((c: any) => c?.id))[0];
  if (linked.length < limit && category) {
    const exclude = [id, ...linked.map((p) => String(p.id))];
    const got = await read("woocommerce.list_products", { category, exclude, in_stock: true, per_page: limit * 2 });
    sameCategory = (got.ok && Array.isArray(got.result) ? (got.result as any[]) : [])
      .filter(sellable)
      .filter((p) => !exclude.includes(String(p.id)))
      .slice(0, limit - linked.length);
  }

  return { ok: true, result: [...linked, ...sameCategory], sources: { linked: linked.length, sameCategory: sameCategory.length } };
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
  return /סוודר|סריג|קרדיגן|חולצ|טישירט|טי-שירט|גופי|מעיל|ז'קט|ג'קט|שמל|חצאית|מכנס|ג'ינס|צעיף|כובע|תיק|גרב|נעל|קפוצ'ון|הודי|טרנץ'|כותנה|צמר|פשתן|עור|ארנק|חגורה|\b(?:tee|t-shirt|shirt|top|coat|jacket|dress|skirt|pants|jeans|scarf|beanie|hat|bag|tote|socks?|hoodie|sweater|cardigan|knit)\b/i.test(t);
}

/** Hebrew shop words and the English the store's titles use (eval L01c: "תיק בד" is a canvas tote). */
export const HEBREW_PRODUCT_GLOSSARY =
  "Hebrew to the English titles use: תיק בד = canvas tote; תיק עור = leather bag; כובע גרב = beanie; קפוצ'ון / הודי = hoodie; " +
  "סוודר / סריג = sweater, knit; קרדיגן = cardigan; גופיה = tank top; טישירט = tee, t-shirt; חולצה מכופתרת = shirt; " +
  "מכנסיים = pants; ג'ינס = jeans; שמלה = dress; חצאית = skirt; מעיל = coat; טרנץ' = trench coat; ז'קט = jacket; צעיף = scarf; גרביים = socks.";
