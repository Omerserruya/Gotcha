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
// Unversioned: graph.instagram.com (Instagram Login) rejects version-prefixed paths.
const IG_API_URL = process.env.INSTAGRAM_API_URL || "https://graph.instagram.com";

// Instagram-Login accounts hold an IG-user token that only works against
// graph.instagram.com; legacy Facebook-Login accounts use a Page token against
// graph.facebook.com. The `igLogin` flag on stored credentials selects the host.
function igBase(credentials: ChannelCredentials): string {
  return credentials.igLogin ? IG_API_URL : FB_API_URL;
}

// ─── Inbound Adapter ─────────────────────────────────────────

export const instagramInboundAdapter: InboundAdapter = {
  channel: "INSTAGRAM",

  canHandle(body: any): boolean {
    return body?.object === "instagram";
  },

  extractMessages(body: any): NormalizedInboundMessage[] {
    const messages: NormalizedInboundMessage[] = [];
    for (const entry of body.entry || []) {
      // Instagram delivers DMs in two shapes depending on the product:
      //   - Facebook-Login IG Messaging:  entry[].messaging[]
      //   - Instagram-Login (graph.instagram.com): entry[].changes[] with
      //     field === "messages" and the event under change.value
      // The event body (sender/recipient/message/postback) is identical; only
      // the envelope and timestamp units (changes = seconds) differ.
      const events = [
        ...(entry.messaging || []),
        ...((entry.changes || [])
          .filter((c: any) => c.field === "messages" && c.value)
          .map((c: any) => c.value)),
      ];
      for (const event of events) {
        // Skip echo messages
        if (event.message?.is_echo) continue;

        const senderId = event.sender?.id;
        if (!senderId) continue;

        // messaging[] timestamps are epoch-ms numbers; changes[] value.timestamp
        // is an epoch-seconds string. Normalize both to a Date.
        const ts = typeof event.timestamp === "string"
          ? new Date(Number(event.timestamp) * 1000)
          : new Date(event.timestamp);

        if (event.message) {
          messages.push({
            externalMessageId: event.message.mid,
            channel: "INSTAGRAM",
            senderId,
            timestamp: ts,
            content: extractInstagramContent(event.message),
          });
        } else if (event.postback) {
          messages.push({
            externalMessageId: `ig_postback_${event.timestamp}_${senderId}`,
            channel: "INSTAGRAM",
            senderId,
            timestamp: ts,
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
    // For DMs (entry.messaging[]): recipient.id is the IG Business Account ID,
    // which matches the externalId we store in DB.
    // For comment events (entry.changes[].field === "comments"): entry.id IS
    // the IG Business Account ID itself - Meta delivers comments keyed by the
    // IG account, not the linked FB Page. Fall back to entry.id when no
    // messaging[] is present.
    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        if (event.recipient?.id) return event.recipient.id;
      }
      // Instagram-Login DMs arrive as changes[] with field "messages"; the
      // business account is value.recipient.id.
      for (const ch of entry.changes || []) {
        if (ch.field === "messages" && ch.value?.recipient?.id) {
          return String(ch.value.recipient.id);
        }
      }
      const hasComments = (entry.changes || []).some(
        (c: any) => c.field === "comments",
      );
      if (hasComments && entry.id) return String(entry.id);
    }
    return null;
  },

  extractCommentEvents(body: any): NormalizedCommentEvent[] {
    // IG comment payload shape (live example from Meta):
    //   entry[].changes[] = [{ field: "comments", value: { id, text, from: {id, username}, media: {id, ...}, parent_id? } }]
    const out: NormalizedCommentEvent[] = [];
    for (const entry of body.entry || []) {
      const ts = typeof entry.time === "number" ? entry.time * 1000 : Date.now();
      for (const change of entry.changes || []) {
        if (change.field !== "comments") continue;
        const v = change.value || {};
        if (!v.id) continue;
        // Echo guard: skip comments authored BY the IG business account itself
        // (e.g. our own private reply landing as a public comment notification).
        if (v.from?.id && entry.id && String(v.from.id) === String(entry.id)) continue;
        out.push({
          channel: "INSTAGRAM",
          commentId: String(v.id),
          postId: String(v.media?.id || ""),
          postPermalink: v.media?.permalink || undefined,
          text: String(v.text || ""),
          fromUserId: String(v.from?.id || ""),
          fromUsername: v.from?.username || undefined,
          timestamp: new Date(ts),
          parentCommentId: v.parent_id ? String(v.parent_id) : undefined,
        });
      }
    }
    return out;
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
        `${igBase(credentials)}/me/messages`,
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
        `${igBase(credentials)}/me/messages`,
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
        `${igBase(credentials)}/me/messages`,
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

  async sendPrivateReply(
    credentials: ChannelCredentials,
    _accountExternalId: string,
    commentId: string,
    text: string,
    quickReplies?: Array<{ id: string; title: string }>,
  ): Promise<{ messageId: string | null; recipientPsid: string | null } | null> {
    // Private Reply on IG Messaging API. The recipient form is exactly
    // `{ comment_id }` - Meta resolves the actual IGSID server-side and
    // returns it in `recipient_id` so the caller can switch to regular DM
    // for any subsequent message in this flow run. 7-day window from comment
    // timestamp is enforced by Meta; outside it this call returns 4xx.
    // IG private replies accept the same `quick_replies` payload as a
    // standard DM - let callers attach buttons on the very first reply.
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
        `${igBase(credentials)}/me/messages`,
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
      console.error("Instagram private-reply error:", err.response?.data || err.message);
      return null;
    }
  },

  async sendCommentReply(
    credentials: ChannelCredentials,
    _accountExternalId: string,
    commentId: string,
    text: string,
  ): Promise<string | null> {
    // Public reply on IG: POST /{ig-comment-id}/replies with `message`.
    // Auth needs `instagram_basic` + `instagram_manage_comments`. Subject to
    // Meta's comment moderation rules (length, banned terms). Returns the new
    // comment's id, which is useful for downstream moderation operations but
    // not required by the walker.
    try {
      const response = await axios.post(
        `${igBase(credentials)}/${commentId}/replies`,
        { message: text },
        { headers: { Authorization: `Bearer ${credentials.accessToken}`, "Content-Type": "application/json" } },
      );
      return response.data?.id || null;
    } catch (err: any) {
      console.error("Instagram comment-reply error:", err.response?.data || err.message);
      return null;
    }
  },
};
