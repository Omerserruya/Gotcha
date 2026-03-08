import crypto from "crypto";
import axios from "axios";
import type {
  InboundAdapter,
  OutboundAdapter,
  NormalizedInboundMessage,
  NormalizedStatusUpdate,
  ChannelCredentials,
} from "./types";

const FB_API_URL = process.env.FACEBOOK_API_URL || "https://graph.facebook.com/v19.0";

// ─── Inbound Adapter ─────────────────────────────────────────

export const messengerInboundAdapter: InboundAdapter = {
  channel: "MESSENGER",

  canHandle(body: any): boolean {
    return body?.object === "page";
  },

  extractMessages(body: any): NormalizedInboundMessage[] {
    const messages: NormalizedInboundMessage[] = [];
    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        // Skip echo messages (messages sent by the page itself)
        if (event.message?.is_echo) continue;

        const senderId = event.sender?.id;
        if (!senderId) continue;

        if (event.message) {
          messages.push({
            externalMessageId: event.message.mid,
            channel: "MESSENGER",
            senderId,
            timestamp: new Date(event.timestamp),
            content: extractMessengerContent(event.message),
          });
        } else if (event.postback) {
          messages.push({
            externalMessageId: `postback_${event.timestamp}_${senderId}`,
            channel: "MESSENGER",
            senderId,
            timestamp: new Date(event.timestamp),
            content: {
              type: "interactive",
              interactiveReply: {
                type: "postback",
                payload: event.postback.payload || "",
                title: event.postback.title || "",
              },
            },
          });
        }
      }
    }
    return messages;
  },

  extractStatusUpdates(body: any): NormalizedStatusUpdate[] {
    const updates: NormalizedStatusUpdate[] = [];
    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        if (event.delivery) {
          for (const mid of event.delivery.mids || []) {
            updates.push({ externalMessageId: mid, status: "delivered" });
          }
        }
        if (event.read) {
          // Messenger read receipts don't have per-message IDs
          // They indicate all messages up to a watermark were read
          // We handle this at the worker level if needed
        }
      }
    }
    return updates;
  },

  resolveChannelAccountExternalId(body: any): string | null {
    // The page ID is the recipient.id in incoming messages
    for (const entry of body.entry || []) {
      // entry.id is the page ID
      if (entry.id) return entry.id;
      for (const event of entry.messaging || []) {
        if (event.recipient?.id) return event.recipient.id;
      }
    }
    return null;
  },

  verifySignature(appSecret: string, rawBody: Buffer, signature: string): boolean {
    const expectedSig = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
    try {
      return crypto.timingSafeEqual(Buffer.from(`sha256=${expectedSig}`), Buffer.from(signature));
    } catch {
      return false;
    }
  },

  getSignatureHeader(): string {
    return "x-hub-signature-256";
  },
};

function extractMessengerContent(message: any): NormalizedInboundMessage["content"] {
  // Quick reply (button tap)
  if (message.quick_reply) {
    return {
      type: "interactive",
      text: message.text || "",
      interactiveReply: {
        type: "quick_reply",
        payload: message.quick_reply.payload || "",
        title: message.text || "",
      },
    };
  }

  // Text message
  if (message.text) {
    return { type: "text", text: message.text };
  }

  // Attachments
  if (message.attachments?.length) {
    const attachment = message.attachments[0];
    switch (attachment.type) {
      case "image":
        return { type: "image", mediaUrl: attachment.payload?.url, caption: "[Image]" };
      case "video":
        return { type: "video", mediaUrl: attachment.payload?.url, caption: "[Video]" };
      case "audio":
        return { type: "audio", mediaUrl: attachment.payload?.url, text: "[Audio message]" };
      case "file":
        return { type: "document", mediaUrl: attachment.payload?.url, caption: "[Document]" };
      case "location":
        const coords = attachment.payload?.coordinates;
        return { type: "location", text: `[Location: ${coords?.lat}, ${coords?.long}]` };
      default:
        return { type: "text", text: `[${attachment.type} attachment]` };
    }
  }

  return { type: "text", text: "[Unknown message]" };
}

// ─── Outbound Adapter ────────────────────────────────────────

export const messengerOutboundAdapter: OutboundAdapter = {
  channel: "MESSENGER",

  async sendTextMessage(
    credentials: ChannelCredentials,
    _accountExternalId: string,
    recipientId: string,
    text: string
  ): Promise<string | null> {
    try {
      const response = await axios.post(
        `${FB_API_URL}/me/messages`,
        {
          recipient: { id: recipientId },
          message: { text },
          messaging_type: "RESPONSE",
        },
        { headers: { Authorization: `Bearer ${credentials.accessToken}`, "Content-Type": "application/json" } }
      );
      return response.data?.message_id || null;
    } catch (err: any) {
      console.error("Messenger send error:", err.response?.data || err.message);
      return null;
    }
  },

  async sendInteractiveMessage(
    credentials: ChannelCredentials,
    _accountExternalId: string,
    recipientId: string,
    bodyText: string,
    buttons: Array<{ id: string; title: string }>
  ): Promise<string | null> {
    try {
      // Messenger uses quick_replies for button-like interactions
      const response = await axios.post(
        `${FB_API_URL}/me/messages`,
        {
          recipient: { id: recipientId },
          messaging_type: "RESPONSE",
          message: {
            text: bodyText,
            quick_replies: buttons.slice(0, 13).map((b) => ({
              content_type: "text",
              title: b.title,
              payload: b.id,
            })),
          },
        },
        { headers: { Authorization: `Bearer ${credentials.accessToken}`, "Content-Type": "application/json" } }
      );
      return response.data?.message_id || null;
    } catch (err: any) {
      console.error("Messenger interactive send error:", err.response?.data || err.message);
      return null;
    }
  },

  async sendMediaMessage(
    credentials: ChannelCredentials,
    _accountExternalId: string,
    recipientId: string,
    mediaUrl: string,
    mediaType: "image" | "video" | "document",
    _fileName?: string,
    _caption?: string
  ): Promise<string | null> {
    try {
      const attachmentType = mediaType === "document" ? "file" : mediaType;
      const response = await axios.post(
        `${FB_API_URL}/me/messages`,
        {
          recipient: { id: recipientId },
          messaging_type: "RESPONSE",
          message: {
            attachment: {
              type: attachmentType,
              payload: { url: mediaUrl, is_reusable: true },
            },
          },
        },
        { headers: { Authorization: `Bearer ${credentials.accessToken}`, "Content-Type": "application/json" } }
      );
      return response.data?.message_id || null;
    } catch (err: any) {
      console.error(`Messenger ${mediaType} send error:`, err.response?.data || err.message);
      return null;
    }
  },
};
