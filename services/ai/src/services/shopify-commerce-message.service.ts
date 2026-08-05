/**
 * Structured commerce messages.
 *
 * A product card is a normal Message row - same conversation, same inbox,
 * same history - carrying a validated snapshot in `metadata`. It is NOT
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
  type ProductSnapshot,
  type ShopifyCommerceMessagePayload,
} from "@chatcenter/shared";

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
}

export interface SendProductMessageResult {
  ok: true;
  messageId: string;
  productCount: number;
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

  return {
    ok: true,
    messageId: message.id,
    productCount: (record.metadata.shopify as ShopifyCommerceMessagePayload).products.length,
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
    return `${p.title}${price} - ${p.productUrl}`;
  }
  const titles = products.map((p) => p.title).join(", ");
  return `${products.length} product suggestions: ${titles}`;
}
