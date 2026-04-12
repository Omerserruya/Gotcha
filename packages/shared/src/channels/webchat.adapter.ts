import type { OutboundAdapter, ChannelCredentials } from "./types";
import crypto from "crypto";

/**
 * Webchat outbound adapter.
 *
 * For webchat, "sending" a message doesn't call an external API.
 * The message is saved to DB by the caller (ai-bot.service / chatbot-engine),
 * and the widget polls for new messages via GET /api/embedded-chat/messages/:sessionId.
 *
 * This adapter just generates a unique external message ID so the pipeline
 * doesn't break when trying to send replies to webchat conversations.
 */
export const webchatOutboundAdapter: OutboundAdapter = {
  channel: "WEBCHAT",

  async sendTextMessage(
    _credentials: ChannelCredentials,
    _accountExternalId: string,
    _recipientId: string,
    _text: string
  ): Promise<string | null> {
    // No external API to call — widget polls DB directly.
    // Return a generated ID so the message record gets a valid externalMessageId.
    return `webchat_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  },

  async sendInteractiveMessage(
    _credentials: ChannelCredentials,
    _accountExternalId: string,
    _recipientId: string,
    _bodyText: string,
    _buttons: Array<{ id: string; title: string }>
  ): Promise<string | null> {
    return `webchat_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  },
};
