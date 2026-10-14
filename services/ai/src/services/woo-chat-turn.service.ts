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

export interface WooTurn {
  provider: "woocommerce";
  storeUrl: string;
  channelAccountId: string;
  productMessagingEnabled: true;
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
export const WOO_TURN_HIDDEN_TOOLS: ReadonlySet<string> = new Set(["shopify.search_products", "shopify.get_product"]);

/** The tool surface without the other store's catalogue (unchanged when there is no Woo turn). */
export function withoutOtherStoreTools<T extends { function?: { name?: string } }>(tools: T[], wooTurn: WooTurn | null): T[] {
  return wooTurn ? tools.filter((t) => !WOO_TURN_HIDDEN_TOOLS.has(String(t?.function?.name ?? ""))) : tools;
}

/** Cards only from the store the search read: never a Shopify result on the Woo store, or the reverse. */
export function cardsMatchTurn(envelopeProvider: "shopify" | "woocommerce", wooTurn: WooTurn | null): boolean {
  return envelopeProvider === (wooTurn ? "woocommerce" : "shopify");
}
