import crypto from "crypto";
import axios from "axios";
import type {
  InboundAdapter,
  OutboundAdapter,
  NormalizedInboundMessage,
  NormalizedStatusUpdate,
  NormalizedCommentEvent,
  ChannelCredentials,
} from "./types";
import { metaGraphBaseUrl } from "../lib/meta-graph-version";

const FB_API_URL = metaGraphBaseUrl(process.env.FACEBOOK_API_URL);

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
            // Meta's other channels put the quoted message on `reply_to.mid`.
            replyToExternalId: event.message.reply_to?.mid ? String(event.message.reply_to.mid) : undefined,
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

  extractCommentEvents(body: any): NormalizedCommentEvent[] {
    // FB feed comment payload shape:
    //   entry[].changes[] = [{ field: "feed", value: { item: "comment", verb: "add"|"edit"|"remove",
    //                          comment_id, post_id, parent_id?, message, from: {id, name}, permalink_url, created_time } }]
    // We only fire triggers on "add" - edits/removes/hides should not re-trigger
    // a flow.
    const out: NormalizedCommentEvent[] = [];
    for (const entry of body.entry || []) {
      const pageId = entry.id ? String(entry.id) : "";
      for (const change of entry.changes || []) {
        if (change.field !== "feed") continue;
        const v = change.value || {};
        if (v.item !== "comment" || v.verb !== "add") continue;
        if (!v.comment_id) continue;
        // Echo guard: skip when the page itself is the commenter (e.g. a public
        // reply we just posted) - fromUserId === pageId means it's us.
        if (pageId && v.from?.id && String(v.from.id) === pageId) continue;
        const ts = typeof v.created_time === "number"
          ? v.created_time * 1000
          : (typeof entry.time === "number" ? entry.time * 1000 : Date.now());
        out.push({
          channel: "MESSENGER",
          commentId: String(v.comment_id),
          postId: String(v.post_id || ""),
          postPermalink: v.permalink_url || undefined,
          text: String(v.message || ""),
          fromUserId: String(v.from?.id || ""),
          fromUsername: v.from?.name || undefined,
          timestamp: new Date(ts),
          parentCommentId: v.parent_id ? String(v.parent_id) : undefined,
        });
      }
    }
    return out;
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
        return { type: "audio", mediaUrl: attachment.payload?.url, text: "[Audio message]", voice: true };
      case "file":
        // Messenger puts the sender's filename on the attachment when it has
        // one. Without it the inbox offers a download labelled by our own
        // generated name, which tells the agent nothing about what it is.
        return {
          type: "document",
          mediaUrl: attachment.payload?.url,
          caption: attachment.name || "[Document]",
          fileName: attachment.name,
        };
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

  async sendPrivateReply(
    credentials: ChannelCredentials,
    _accountExternalId: string,
    commentId: string,
    text: string,
    quickReplies?: Array<{ id: string; title: string }>,
  ): Promise<{ messageId: string | null; recipientPsid: string | null } | null> {
    // Messenger Private Reply - same shape as IG: recipient.comment_id, no
    // messaging_type. Meta returns the recipient PSID so subsequent sends in
    // this run can use the regular DM endpoint with messaging_type=RESPONSE.
    // 7-day window enforced by Meta. Quick replies attach to the very first
    // private reply same as a standard DM.
    try {
      const message: Record<string, any> = { text };
      if (quickReplies && quickReplies.length > 0) {
        message.quick_replies = quickReplies.slice(0, 13).map((b) => ({
          content_type: "text",
          title: b.title,
          payload: b.id,
        }));
      }
      const response = await axios.post(
        `${FB_API_URL}/me/messages`,
        {
          recipient: { comment_id: commentId },
          message,
        },
        { headers: { Authorization: `Bearer ${credentials.accessToken}`, "Content-Type": "application/json" } },
      );
      return {
        messageId: response.data?.message_id || null,
        recipientPsid: response.data?.recipient_id || null,
      };
    } catch (err: any) {
      console.error("Messenger private-reply error:", err.response?.data || err.message);
      return null;
    }
  },

  async sendCommentReply(
    credentials: ChannelCredentials,
    _accountExternalId: string,
    commentId: string,
    text: string,
  ): Promise<string | null> {
    // Public reply on FB: POST /{comment-id}/comments with `message`. Posts a
    // child comment under the original. Page must have `pages_manage_engagement`
    // (and the page access token must be on `credentials.accessToken`).
    // Returns the new comment id.
    try {
      const response = await axios.post(
        `${FB_API_URL}/${commentId}/comments`,
        { message: text },
        { headers: { Authorization: `Bearer ${credentials.accessToken}`, "Content-Type": "application/json" } },
      );
      return response.data?.id || null;
    } catch (err: any) {
      console.error("Messenger comment-reply error:", err.response?.data || err.message);
      return null;
    }
  },
};
