/**
 * Shopify Live Chat — realtime relay to storefront visitors.
 *
 * Reuses the transport the inbox already runs on rather than standing up
 * a second one: the same `message:new` event that lights up an agent's
 * screen is projected into the visitor's single conversation room.
 *
 * Two things make that safe:
 *   1. A visitor socket joins exactly ONE room (`visitor:<conversationId>`)
 *      and never a tenant-wide room — see lib/socket.ts.
 *   2. Everything leaving here goes through the shared visitor projection,
 *      the same function the polling endpoint uses, so the streaming and
 *      polling views cannot drift apart on what is safe to expose.
 */

import {
  prisma,
  readShopifyLiveChatConfig,
  projectVisitorMessage,
  type ServiceEvent,
} from "@chatcenter/shared";
import { getIO } from "../lib/socket";

/**
 * Channel config is read once per channel and cached briefly. A relay
 * that hit the database on every message would turn a busy storefront
 * into a query storm for data that changes when a merchant edits their
 * branding.
 */
interface ChannelCacheEntry {
  assistantName: string;
  shopDomain: string;
  expiresAt: number;
}
const CHANNEL_TTL_MS = 60_000;
const channelCache = new Map<string, ChannelCacheEntry | null>();

/** Test-only: drop the channel cache. */
export function __resetVisitorRelayCache(): void {
  channelCache.clear();
}

export async function relayToVisitor(event: ServiceEvent): Promise<void> {
  if (event.event !== "message:new") return;
  const message = event.data?.message;
  const conversationId = event.data?.conversationId;
  if (!message?.id || !conversationId) return;
  if (event.data?.channel !== "SHOPIFY_LIVE_CHAT" && message.channel !== "SHOPIFY_LIVE_CHAT") {
    return;
  }

  // No listener, no work. This is the common case for a storefront where
  // nobody currently has the widget open.
  let room;
  try {
    room = getIO().to(`visitor:${conversationId}`);
    const sockets = await getIO().in(`visitor:${conversationId}`).fetchSockets();
    if (sockets.length === 0) return;
  } catch {
    return;
  }

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId: event.tenantId },
    select: { channelAccountId: true },
  });
  if (!conversation?.channelAccountId) return;

  const channel = await loadChannelMeta(event.tenantId, conversation.channelAccountId);
  if (!channel) return;

  const view = projectVisitorMessage(
    {
      id: message.id,
      direction: message.direction,
      body: message.body ?? "",
      messageType: message.messageType ?? "text",
      senderName: message.senderName ?? null,
      metadata: message.metadata,
      mediaUrl: message.mediaUrl ?? null,
      createdAt: message.createdAt ?? new Date().toISOString(),
    },
    {
      assistantName: channel.assistantName,
      shopDomain: channel.shopDomain,
      channelAccountId: conversation.channelAccountId,
    },
  );
  if (!view) return;

  room.emit("visitor:message", { conversationId, message: view });
}

async function loadChannelMeta(
  tenantId: string,
  channelAccountId: string,
): Promise<ChannelCacheEntry | null> {
  const cached = channelCache.get(channelAccountId);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const row = await prisma.channelAccount.findFirst({
    where: { id: channelAccountId, tenantId, channel: "SHOPIFY_LIVE_CHAT" as any },
    select: { platformMeta: true },
  });
  if (!row) {
    channelCache.set(channelAccountId, null);
    return null;
  }
  const config = readShopifyLiveChatConfig(row.platformMeta);
  const entry: ChannelCacheEntry = {
    assistantName: config.welcome.assistantName,
    shopDomain: config.shopDomain ?? "",
    expiresAt: Date.now() + CHANNEL_TTL_MS,
  };
  channelCache.set(channelAccountId, entry);
  return entry;
}

/**
 * Conversation-level state the widget reacts to (handed to a human,
 * closed). Carries no content, so there is nothing to project.
 */
export function relayConversationState(event: ServiceEvent): void {
  if (event.event !== "conversation:updated" && event.event !== "conversation:closed") return;
  if (event.data?.channel !== "SHOPIFY_LIVE_CHAT") return;
  const conversationId = event.data?.id ?? event.data?.conversationId;
  if (!conversationId) return;
  try {
    getIO().to(`visitor:${conversationId}`).emit("visitor:conversation", {
      conversationId,
      status: event.data?.status ?? null,
      isHandedOver: event.data?.isHandedOver ?? null,
    });
  } catch {
    /* socket not ready */
  }
}
