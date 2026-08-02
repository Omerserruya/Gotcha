/**
 * Shopify Live Chat — per-turn AI wiring.
 *
 * Everything the AI employee needs that is specific to this channel,
 * assembled once per bot turn:
 *
 *   - the verified storefront context block (what page the shopper is on,
 *     and the SERVER-RESOLVED product for that page)
 *   - the `send_product_card` / `send_product_carousel` handler
 *
 * Product messages are STAGED, not written. The bot's text reply is
 * persisted by the incoming worker after this service returns, and a card
 * that appeared before its own explanation reads like an ad. Staging lets
 * the worker write them in the order the customer should read them.
 */

import {
  MAX_CAROUSEL_ITEMS,
  type ProductSnapshot,
  type SendShopifyProductsArgs,
  type SendShopifyProductsResult,
  type StorefrontContext,
} from "@chatcenter/shared";
import { prisma } from "@chatcenter/shared";
import {
  loadChannelForConversation,
  isProductMessagingAllowed,
  type ShopifyLiveChatChannel,
} from "./shopify-live-chat.service";
import {
  getProductSnapshot,
  getProductSnapshots,
  resolveShopifyStore,
  type ShopifyStoreBinding,
} from "./shopify-catalog.service";
import {
  buildProductMessageRecord,
  type ProductMessageRecord,
} from "./shopify-commerce-message.service";

export interface ShopifyTurn {
  channel: ShopifyLiveChatChannel;
  store: ShopifyStoreBinding;
  productMessagingEnabled: boolean;
  /** Rendered `## Shopify Storefront` block, or undefined when there is none. */
  storefrontBlock?: string;
  /** Product messages the model asked for this turn, in call order. */
  staged: ProductMessageRecord[];
  /** Wired into AgentToolContext.sendShopifyProducts when messaging is on. */
  sendShopifyProducts?: (args: SendShopifyProductsArgs) => Promise<SendShopifyProductsResult>;
}

/**
 * Returns null for every non-Shopify-Live-Chat conversation, which is the
 * common case — callers treat null as "nothing to add this turn".
 */
export async function prepareShopifyTurn(opts: {
  tenantId: string;
  conversationId: string;
}): Promise<ShopifyTurn | null> {
  const found = await loadChannelForConversation(opts.tenantId, opts.conversationId);
  if (!found) return null;
  const { channel } = found;

  const storeResolution = await resolveShopifyStore(opts.tenantId);
  if (!storeResolution.ok) {
    // Store went away mid-conversation. Chat keeps working; the model
    // simply gets no storefront facts and no product tools.
    return {
      channel,
      store: { tenantIntegrationId: "", shopDomain: channel.config.shopDomain ?? "", currency: "USD" },
      productMessagingEnabled: false,
      staged: [],
    };
  }
  const store = storeResolution.store;

  // Binding check: if the workspace has since connected a DIFFERENT store,
  // this channel's products would come from a shop the shopper is not on.
  // Refuse product messaging rather than show them a stranger's catalogue.
  const boundToConnectedStore = store.shopDomain === channel.config.shopDomain;
  const productMessagingEnabled =
    boundToConnectedStore && (await isProductMessagingAllowed(opts.tenantId, channel.config));

  const context = await readLatestStorefrontContext(opts.tenantId, opts.conversationId);
  const storefrontBlock = context
    ? await renderStorefrontBlock({
        tenantId: opts.tenantId,
        channel,
        store,
        context,
        resolveProduct: boundToConnectedStore,
      })
    : undefined;

  const turn: ShopifyTurn = {
    channel,
    store,
    productMessagingEnabled,
    storefrontBlock,
    staged: [],
  };

  if (productMessagingEnabled) {
    turn.sendShopifyProducts = (args) => stageProducts(turn, opts.tenantId, args);
  }
  return turn;
}

// ─── Storefront context ──────────────────────────────────────

/**
 * The page context rides on the visitor's own message, so "what were they
 * looking at when they asked this?" is answered by the message itself
 * rather than by a mutable per-conversation field that a later page view
 * would have already overwritten.
 */
async function readLatestStorefrontContext(
  tenantId: string,
  conversationId: string,
): Promise<StorefrontContext | null> {
  const row = await prisma.message.findFirst({
    where: { tenantId, conversationId, direction: "INBOUND" },
    orderBy: { createdAt: "desc" },
    select: { metadata: true },
  });
  const raw = (row?.metadata as any)?.storefront;
  if (!raw || typeof raw !== "object") return null;
  return raw as StorefrontContext;
}

async function renderStorefrontBlock(opts: {
  tenantId: string;
  channel: ShopifyLiveChatChannel;
  store: ShopifyStoreBinding;
  context: StorefrontContext;
  resolveProduct: boolean;
}): Promise<string | undefined> {
  const { context } = opts;
  const lines: string[] = ["## Shopify Storefront"];
  lines.push(`Store: ${opts.store.shopDomain}`);
  lines.push(`Page the customer is on: ${context.pageType}`);
  if (context.currency) lines.push(`Storefront currency: ${context.currency}`);
  if (context.locale) lines.push(`Storefront locale: ${context.locale}`);
  if (typeof context.cartItemCount === "number") {
    lines.push(`Items currently in their cart: ${context.cartItemCount}`);
  }

  if (opts.resolveProduct && context.pageType === "product" && context.productHandle) {
    // The handle came from a browser; every fact below did not. We look
    // the product up ourselves so "is this good for long runs?" is
    // answered about the real product at the real price.
    const r = await getProductSnapshot({
      tenantId: opts.tenantId,
      handle: context.productHandle,
      store: opts.store,
    });
    if (r.ok && r.data) {
      lines.push("", "The customer is currently viewing THIS product:");
      lines.push(describeProduct(r.data));
      lines.push(
        "",
        'If they say "this", "it" or "this one" without naming a product, they mean the product above.',
      );
    } else {
      lines.push("", "They are on a product page, but that product could not be loaded from Shopify.");
      lines.push("Ask which product they mean rather than guessing.");
    }
  }

  return lines.length > 3 ? lines.join("\n") : lines.join("\n");
}

function describeProduct(p: ProductSnapshot): string {
  const parts = [`- ${p.title}`];
  if (p.price) parts.push(`price ${p.price} ${p.currency}`);
  if (p.compareAtPrice && p.compareAtPrice !== p.price) parts.push(`was ${p.compareAtPrice}`);
  parts.push(p.available ? "in stock" : "out of stock");
  if (p.vendor) parts.push(`by ${p.vendor}`);
  const variantSummary = p.variants
    .slice(0, 8)
    .map((v) => `${v.title}${v.available ? "" : " (unavailable)"}`)
    .join(", ");
  const idLine = `  product_id: ${p.productId}`;
  return [
    parts.join(" — "),
    idLine,
    p.optionNames.length ? `  options: ${p.optionNames.join(", ")}` : "",
    variantSummary ? `  variants: ${variantSummary}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// ─── Product message staging ─────────────────────────────────

async function stageProducts(
  turn: ShopifyTurn,
  tenantId: string,
  args: SendShopifyProductsArgs,
): Promise<SendShopifyProductsResult> {
  const refs = (args.products ?? []).slice(0, turn.channel.config.commerce.carouselSize || MAX_CAROUSEL_ITEMS);
  if (!refs.length) return { ok: false, reason: "no_products" };

  const resolved = await getProductSnapshots(
    tenantId,
    refs.map((r) => ({
      productId: r.productId ?? null,
      handle: r.handle ?? null,
      variantId: r.variantId ?? null,
      reason: r.reason ?? null,
    })),
    turn.store,
  );
  if (!resolved.ok) return { ok: false, reason: resolved.reason };

  // A model that hallucinated an id gets nothing back rather than an
  // invented card — this is the concrete mechanism behind "the AI cannot
  // invent a product".
  const products: ProductSnapshot[] = resolved.data.filter((p) =>
    turn.channel.config.commerce.allowUnpublishedProducts ? true : p.status === "active",
  );
  if (!products.length) {
    return {
      ok: false,
      reason: "no_matching_products: none of those ids resolved to a live product in this store",
    };
  }

  const record = buildProductMessageRecord({
    shopDomain: turn.channel.config.shopDomain!,
    channelAccountId: turn.channel.id,
    products,
    addToCartEnabled: turn.channel.config.commerce.addToCartEnabled,
    source: "ai",
  });
  if (!record) return { ok: false, reason: "store_mismatch" };

  turn.staged.push(record);

  return {
    ok: true,
    products: products.map((p) => ({
      title: p.title,
      price: p.price,
      currency: p.currency,
      available: p.available,
    })),
  };
}
