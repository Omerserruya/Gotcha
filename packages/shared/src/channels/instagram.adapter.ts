import crypto from "crypto";
import axios from "axios";
import type {
  InboundAdapter,
  OutboundAdapter,
  NormalizedInboundMessage,
  NormalizedStatusUpdate,
  ChannelCredentials,
} from "./types";

const FB_API_URL = process.env.FACEBOOK_API_URL || "https://graph.facebook.com/v21.0";

// ─── Inbound Adapter ─────────────────────────────────────────

export const instagramInboundAdapter: InboundAdapter = {
  channel: "INSTAGRAM",

  canHandle(body: any): boolean {
    return body?.object === "instagram";
  },

  extractMessages(body: any): NormalizedInboundMessage[] {
    const messages: NormalizedInboundMessage[] = [];
    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        // Skip echo messages
        if (event.message?.is_echo) continue;

        const senderId = event.sender?.id;
        if (!senderId) continue;

        if (event.message) {
          messages.push({
            externalMessageId: event.message.mid,
            channel: "INSTAGRAM",
            senderId,
            timestamp: new Date(event.timestamp),
            content: extractInstagramContent(event.message),
          });
        } else if (event.postback) {
          messages.push({
            externalMessageId: `ig_postback_${event.timestamp}_${senderId}`,
            channel: "INSTAGRAM",
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
      }
    }
    return updates;
  },

  resolveChannelAccountExternalId(body: any): string | null {
    // entry[].id is the Facebook Page ID, NOT the IG Business Account ID.
    // recipient.id is the Instagram Business Account ID — matches externalId stored in DB.
    for (const entry of body.entry || []) {
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

function extractInstagramContent(message: any): NormalizedInboundMessage["content"] {
  // Quick reply
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
      case "share":
        return { type: "text", text: "[Shared post]" };
      case "story_mention":
        return { type: "text", text: "[Story mention]" };
      default:
        return { type: "text", text: `[${attachment.type} attachment]` };
    }
  }

  return { type: "text", text: "[Unknown message]" };
}

// ─── Outbound Adapter ────────────────────────────────────────

export const instagramOutboundAdapter: OutboundAdapter = {
  channel: "INSTAGRAM",

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
        },
        { headers: { Authorization: `Bearer ${credentials.accessToken}`, "Content-Type": "application/json" } }
      );
      return response.data?.message_id || null;
    } catch (err: any) {
      console.error("Instagram send error:", err.response?.data || err.message);
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
      // Instagram supports quick_replies similar to Messenger
      const response = await axios.post(
        `${FB_API_URL}/me/messages`,
        {
          recipient: { id: recipientId },
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
      console.error("Instagram interactive send error:", err.response?.data || err.message);
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
          message: {
            attachment: {
              type: attachmentType,
              payload: { url: mediaUrl },
            },
          },
        },
        { headers: { Authorization: `Bearer ${credentials.accessToken}`, "Content-Type": "application/json" } }
      );
      return response.data?.message_id || null;
    } catch (err: any) {
      console.error(`Instagram ${mediaType} send error:`, err.response?.data || err.message);
      return null;
    }
  },
};
