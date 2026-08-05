/**
 * Structured commerce messages.
 *
 * A product card is a normal Message row — same conversation, same inbox,
 * same history — carrying a validated snapshot in `metadata`. It is NOT
 * HTML: the widget and the inbox each render the snapshot themselves, so
 * nothing a merchant or a model produces ever becomes markup.
 *
 * `body` still gets a readable plain-text summary. That is what shows in
 * conversation lists, notifications, exports and any channel that has no
 * idea what a product card is.
 */

import {
  prisma,
  publishEvent,
  SHOPIFY_MESSAGE_TYPES,
  MAX_CAROUSEL_ITEMS,
  recommendationSetFromShopifySnapshots,
  type ProductSnapshot,
  type ShopifyCommerceMessagePayload,
} from "@chatcenter/shared";
import {
  planRecommendationDelivery,
  markRecommendationDelivered,
  wasRecommendationDelivered,
} from "./recommendation-delivery.service";

/**
 * The persisted shape of a commerce message, independent of who writes
 * the row.
 *
 * Two callers need it: the human-agent picker (writes immediately, here)
 * and the AI employee path (stages it in the reply result so the worker
 * can write it AFTER the text, keeping "here's why, then here's the
 * product" in the right order).
 */
export interface ProductMessageRecord {
  messageType: string;
  body: string;
  metadata: Record<string, unknown>;
}

export function buildProductMessageRecord(input: {
  shopDomain: string;
  channelAccountId: string;
  products: ProductSnapshot[];
  addToCartEnabled: boolean;
  source: "ai" | "agent";
}): ProductMessageRecord | null {
  const products = input.products.slice(0, MAX_CAROUSEL_ITEMS);
  if (!products.length) return null;
  if (products.some((p) => p.shopDomain !== input.shopDomain)) return null;

  const payload: ShopifyCommerceMessagePayload = {
    kind: "shopify_commerce",
    shopDomain: input.shopDomain,
    channelAccountId: input.channelAccountId,
    products,
    addToCartEnabled: input.addToCartEnabled,
    source: input.source,
  };
  return {
    messageType:
      products.length > 1
        ? SHOPIFY_MESSAGE_TYPES.PRODUCT_CAROUSEL
        : SHOPIFY_MESSAGE_TYPES.PRODUCT,
    body: summarize(products),
    metadata: { source: input.source === "ai" ? "ai_bot" : "agent", shopify: payload },
  };
}

export interface SendProductMessageInput {
  tenantId: string;
  conversationId: string;
  channelAccountId: string;
  shopDomain: string;
  products: ProductSnapshot[];
  source: "ai" | "agent";
  senderName: string;
  addToCartEnabled: boolean;
  /** Optional lead-in text sent as its own message before the card. */
  leadText?: string | null;
  /** Customer's language, for the labels the renderer attaches. */
  locale?: "he" | "en";
}

export interface SendProductMessageResult {
  ok: true;
  messageId: string;
  productCount: number;
  /** How the channel will present these. "native_carousel" on the storefront. */
  presentation: string;
  /** Content-derived; a retry carrying the same key is refused. */
  idempotencyKey: string;
}

export type SendProductMessageOutcome = SendProductMessageResult | { ok: false; reason: string };

export async function sendProductMessage(
  input: SendProductMessageInput,
): Promise<SendProductMessageOutcome> {
  // A snapshot from another store must never be attached to this
  // conversation. The catalog service already scopes by tenant; the
  // record builder re-checks at the write boundary and refuses.
  const record = buildProductMessageRecord({
    shopDomain: input.shopDomain,
    channelAccountId: input.channelAccountId,
    products: input.products,
    addToCartEnabled: input.addToCartEnabled,
    source: input.source,
  });
  if (!record) {
    return { ok: false, reason: input.products.length ? "store_mismatch" : "no_products" };
  }

  // The channel decision, taken in the ONE place that takes it for every
  // channel. On the storefront it comes back "native_carousel", which is
  // what this function already did; routing through it anyway is what
  // makes the storefront a case of the general rule rather than the
  // exception the general rule has to work around.
  const recommendationSet = recommendationSetFromShopifySnapshots({
    products: input.products,
    shopDomain: input.shopDomain,
    introduction: input.leadText,
    addToCartEnabled: input.addToCartEnabled,
  });
  const plan = planRecommendationDelivery({
    channel: "SHOPIFY_LIVE_CHAT",
    recommendationSet,
    locale: input.locale,
  });

  // Retry suppression, on the AI path ONLY.
  //
  // The key is content-derived, so the retry of a timed-out send carries
  // the same one and is recognised. That is exactly right for the AI
  // path, which a worker retries on its own.
  //
  // It would be wrong for the human path. An agent who sends a card, is
  // asked "sorry, which one?", and sends the same card again is making a
  // deliberate choice, not retrying anything, and a composer that
  // silently swallowed it would look broken to the one person who can
  // see both sides of the conversation.
  if (input.source === "ai" && wasRecommendationDelivered(input.conversationId, plan.idempotencyKey)) {
    return { ok: false, reason: "duplicate_recommendation" };
  }

  if (input.leadText && input.leadText.trim()) {
    await createMessage({
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      body: input.leadText.trim(),
      messageType: "text",
      senderName: input.senderName,
      metadata: { source: input.source === "ai" ? "ai_bot" : "agent" },
    });
  }

  const message = await createMessage({
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    body: record.body,
    messageType: record.messageType,
    senderName: input.senderName,
    metadata: record.metadata,
  });

  if (input.source === "ai") {
    markRecommendationDelivered(input.conversationId, plan.idempotencyKey);
  }

  return {
    ok: true,
    messageId: message.id,
    productCount: (record.metadata.shopify as ShopifyCommerceMessagePayload).products.length,
    presentation: plan.presentation,
    idempotencyKey: plan.idempotencyKey,
  };
}

async function createMessage(data: {
  tenantId: string;
  conversationId: string;
  body: string;
  messageType: string;
  senderName: string;
  metadata: Record<string, unknown>;
}) {
  const message = await prisma.message.create({
    data: {
      tenantId: data.tenantId,
      conversationId: data.conversationId,
      channel: "SHOPIFY_LIVE_CHAT" as any,
      direction: "OUTBOUND",
      body: data.body,
      messageType: data.messageType,
      senderName: data.senderName,
      status: "SENT",
      metadata: data.metadata as any,
    },
  });

  await prisma.conversation.update({
    where: { id: data.conversationId },
    data: { lastMessageAt: message.createdAt },
  });

  await publishEvent({
    event: "message:new",
    tenantId: data.tenantId,
    data: { message, conversationId: data.conversationId, channel: "SHOPIFY_LIVE_CHAT" },
  });

  return message;
}

/**
 * Plain-text fallback body. Reads like something a person would type, so
 * a conversation list preview or an email digest still makes sense.
 */
function summarize(products: ProductSnapshot[]): string {
  if (products.length === 1) {
    const p = products[0];
    const price = p.price ? ` (${p.price} ${p.currency})` : "";
    return `${p.title}${price} — ${p.productUrl}`;
  }
  const titles = products.map((p) => p.title).join(", ");
  return `${products.length} product suggestions: ${titles}`;
}
