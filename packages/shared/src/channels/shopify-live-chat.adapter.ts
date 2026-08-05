import type { OutboundAdapter, ChannelCredentials } from "./types";
import crypto from "crypto";

/**
 * Shopify Live Chat outbound adapter.
 *
 * Like webchat, "sending" does not call an external API - the storefront
 * widget owns the last mile. The message row is persisted by the caller
 * (ai-bot.service / conversation service / product-message service) and
 * reaches the visitor two ways:
 *
 *   1. socket.io `visitor:<conversationId>` room (primary), and
 *   2. GET /api/shopify-chat/messages polling (fallback / reconnect).
 *
 * We deliberately do NOT reuse webchatOutboundAdapter: the id prefix is
 * how a message is traced back to the channel it was produced for, and a
 * future divergence (e.g. read receipts) should not have to untangle two
 * channels sharing one adapter.
 */
export const shopifyLiveChatOutboundAdapter: OutboundAdapter = {
  channel: "SHOPIFY_LIVE_CHAT",

  async sendTextMessage(
    _credentials: ChannelCredentials,
    _accountExternalId: string,
    _recipientId: string,
    _text: string
  ): Promise<string | null> {
    return newId();
  },

  async sendInteractiveMessage(
    _credentials: ChannelCredentials,
    _accountExternalId: string,
    _recipientId: string,
    _bodyText: string,
    _buttons: Array<{ id: string; title: string }>
  ): Promise<string | null> {
    return newId();
  },
};

function newId(): string {
  return `sfychat_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}
