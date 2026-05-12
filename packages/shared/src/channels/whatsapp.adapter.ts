import crypto from "crypto";
import axios from "axios";
import type {
  InboundAdapter,
  OutboundAdapter,
  NormalizedInboundMessage,
  NormalizedStatusUpdate,
  ChannelCredentials,
} from "./types";

const WA_API_URL = process.env.WHATSAPP_API_URL || "https://graph.facebook.com/v19.0";

// Pulls the most useful human-readable error out of a WhatsApp/Graph API axios failure.
function extractWaError(err: any): string {
  const data = err?.response?.data;
  const waErr = data?.error;
  if (waErr) {
    const code = waErr.code ? `[${waErr.code}] ` : "";
    const title = waErr.error_user_title || waErr.message || waErr.type || "WhatsApp API error";
    const detail = waErr.error_user_msg || waErr.error_data?.details;
    return `${code}${title}${detail ? ": " + detail : ""}`;
  }
  return err?.message || "WhatsApp send failed";
}

// ─── Inbound Adapter ─────────────────────────────────────────

export const whatsAppInboundAdapter: InboundAdapter = {
  channel: "WHATSAPP",

  canHandle(body: any): boolean {
    return body?.object === "whatsapp_business_account";
  },

  extractMessages(body: any): NormalizedInboundMessage[] {
    const messages: NormalizedInboundMessage[] = [];
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== "messages") continue;
        const value = change.value;
        const contacts = value.contacts || [];
        for (const msg of value.messages || []) {
          const contactName = contacts[0]?.profile?.name || undefined;
          messages.push({
            externalMessageId: msg.id,
            channel: "WHATSAPP",
            senderId: msg.from,
            senderDisplayName: contactName,
            timestamp: new Date(parseInt(msg.timestamp) * 1000),
            content: extractWhatsAppContent(msg),
          });
        }
      }
    }
    return messages;
  },

  extractStatusUpdates(body: any): NormalizedStatusUpdate[] {
    const updates: NormalizedStatusUpdate[] = [];
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== "messages") continue;
        for (const status of change.value?.statuses || []) {
          const statusMap: Record<string, NormalizedStatusUpdate["status"]> = {
            sent: "sent", delivered: "delivered", read: "read", failed: "failed",
          };
          const mapped = statusMap[status.status];
          if (mapped) {
            // Meta attaches a structured errors[] array on failed deliveries.
            // Surface the first entry as a single human-readable string so
            // the rest of the pipeline can persist it on Message.errorMessage
            // (otherwise the operator sees "FAILED" with no reason).
            let errorMessage: string | undefined;
            const errs = Array.isArray(status.errors) ? status.errors : [];
            if (errs.length > 0) {
              const e = errs[0] as any;
              const code = e?.code != null ? `[${e.code}] ` : "";
              const msg = e?.title || e?.message || e?.error_data?.details || "Delivery failed";
              errorMessage = `${code}${msg}`.trim();
            }
            updates.push({
              externalMessageId: status.id,
              status: mapped,
              timestamp: status.timestamp ? new Date(parseInt(status.timestamp) * 1000) : undefined,
              errorMessage,
            });
          }
        }
      }
    }
    return updates;
  },

  resolveChannelAccountExternalId(body: any): string | null {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== "messages") continue;
        return change.value?.metadata?.phone_number_id || null;
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

function extractWhatsAppContent(msg: any): NormalizedInboundMessage["content"] {
  switch (msg.type) {
    case "text":
      return { type: "text", text: msg.text?.body || "" };
    case "interactive":
      return {
        type: "interactive",
        text: "",
        interactiveReply: {
          type: "button",
          payload: msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || "",
          title: msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || "",
        },
      };
    case "image":
      return { type: "image", mediaUrl: msg.image?.id, caption: msg.image?.caption || "[Image]" };
    case "document":
      return { type: "document", mediaUrl: msg.document?.id, caption: msg.document?.caption || "[Document]" };
    case "audio":
      return { type: "audio", text: "[Audio message]" };
    case "video":
      return { type: "video", mediaUrl: msg.video?.id, caption: msg.video?.caption || "[Video]" };
    case "location":
      return { type: "location", text: `[Location: ${msg.location?.latitude}, ${msg.location?.longitude}]` };
    default:
      return { type: "text", text: `[${msg.type || "unknown"} message]` };
  }
}

// ─── Outbound Adapter ────────────────────────────────────────

export const whatsAppOutboundAdapter: OutboundAdapter = {
  channel: "WHATSAPP",

  async sendTextMessage(
    credentials: ChannelCredentials,
    accountExternalId: string,
    recipientId: string,
    text: string
  ): Promise<string | null> {
    try {
      const response = await axios.post(
        `${WA_API_URL}/${accountExternalId}/messages`,
        { messaging_product: "whatsapp", to: recipientId, type: "text", text: { body: text } },
        { headers: { Authorization: `Bearer ${credentials.accessToken}`, "Content-Type": "application/json" } }
      );
      return response.data?.messages?.[0]?.id || null;
    } catch (err: any) {
      throw new Error(extractWaError(err));
    }
  },

  async sendInteractiveMessage(
    credentials: ChannelCredentials,
    accountExternalId: string,
    recipientId: string,
    bodyText: string,
    buttons: Array<{ id: string; title: string }>
  ): Promise<string | null> {
    try {
      const response = await axios.post(
        `${WA_API_URL}/${accountExternalId}/messages`,
        {
          messaging_product: "whatsapp", to: recipientId, type: "interactive",
          interactive: {
            type: "button", body: { text: bodyText },
            action: { buttons: buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) },
          },
        },
        { headers: { Authorization: `Bearer ${credentials.accessToken}`, "Content-Type": "application/json" } }
      );
      return response.data?.messages?.[0]?.id || null;
    } catch (err: any) {
      throw new Error(extractWaError(err));
    }
  },

  async sendMediaMessage(
    credentials: ChannelCredentials,
    accountExternalId: string,
    recipientId: string,
    mediaUrl: string,
    mediaType: "image" | "video" | "document",
    fileName?: string,
    caption?: string
  ): Promise<string | null> {
    try {
      const mediaPayload: Record<string, any> = { link: mediaUrl };
      if (caption) mediaPayload.caption = caption;
      if (mediaType === "document" && fileName) mediaPayload.filename = fileName;

      const response = await axios.post(
        `${WA_API_URL}/${accountExternalId}/messages`,
        {
          messaging_product: "whatsapp",
          to: recipientId,
          type: mediaType,
          [mediaType]: mediaPayload,
        },
        { headers: { Authorization: `Bearer ${credentials.accessToken}`, "Content-Type": "application/json" } }
      );
      return response.data?.messages?.[0]?.id || null;
    } catch (err: any) {
      throw new Error(extractWaError(err));
    }
  },

  async sendTemplateMessage(
    credentials: ChannelCredentials,
    accountExternalId: string,
    recipientId: string,
    templateName: string,
    language: string,
    components?: any[]
  ): Promise<string | null> {
    try {
      const payload: any = {
        messaging_product: "whatsapp",
        to: recipientId,
        type: "template",
        template: {
          name: templateName,
          language: { code: language },
        },
      };
      if (components && components.length > 0) {
        payload.template.components = components;
      }
      const response = await axios.post(
        `${WA_API_URL}/${accountExternalId}/messages`,
        payload,
        { headers: { Authorization: `Bearer ${credentials.accessToken}`, "Content-Type": "application/json" } }
      );
      return response.data?.messages?.[0]?.id || null;
    } catch (err: any) {
      throw new Error(extractWaError(err));
    }
  },
};
