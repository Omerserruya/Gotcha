import crypto from "crypto";
import type {
  InboundAdapter,
  OutboundAdapter,
  NormalizedInboundMessage,
  NormalizedStatusUpdate,
  ChannelCredentials,
} from "./types";

// ─── Outlook Inbound Adapter ───────────────────────────────

export const outlookInboundAdapter: InboundAdapter = {
  channel: "OUTLOOK",

  canHandle(body: any): boolean {
    // Microsoft Graph webhook notification format
    return (
      Array.isArray(body?.value) &&
      body.value.length > 0 &&
      body.value[0]?.resourceData !== undefined &&
      body.value[0]?.changeType !== undefined
    );
  },

  extractMessages(body: any): NormalizedInboundMessage[] {
    const messages: NormalizedInboundMessage[] = [];

    for (const notification of body.value || []) {
      if (notification.changeType !== "created") continue;

      // Microsoft Graph sends a notification with resource data
      // The full message content is fetched via Graph API by the incoming worker
      const resourceData = notification.resourceData || {};
      const senderId = resourceData["@odata.id"] || notification.resource || "";

      messages.push({
        externalMessageId: notification.resourceData?.id || crypto.randomUUID(),
        channel: "OUTLOOK",
        senderId,
        timestamp: new Date(),
        content: {
          type: "text",
          text: resourceData.preview || "[Outlook notification]",
        },
      });
    }

    return messages;
  },

  extractStatusUpdates(_payload: any): NormalizedStatusUpdate[] {
    return [];
  },

  resolveChannelAccountExternalId(body: any): string | null {
    // Extract the subscription ID or mailbox identifier
    const firstNotification = body?.value?.[0];
    if (!firstNotification) return null;

    // The subscriptionId links back to the channel account
    // We store the user's email as externalId when creating the subscription
    return firstNotification.subscriptionId || null;
  },

  verifySignature(_appSecret: string, _rawBody: Buffer, signature: string): boolean {
    // Microsoft Graph validates subscriptions via a clientState value
    // included in the subscription creation request
    // The clientState is sent back in every notification
    if (!signature || !_appSecret) return true;
    try {
      return crypto.timingSafeEqual(
        Buffer.from(_appSecret),
        Buffer.from(signature)
      );
    } catch {
      return false;
    }
  },

  getSignatureHeader(): string {
    return "x-client-state";
  },
};

// ─── Outlook Outbound Adapter ──────────────────────────────

const GRAPH_API_URL = "https://graph.microsoft.com/v1.0";

export const outlookOutboundAdapter: OutboundAdapter = {
  channel: "OUTLOOK",

  async sendTextMessage(
    credentials: ChannelCredentials,
    _accountExternalId: string,
    recipientId: string,
    text: string
  ): Promise<string | null> {
    try {
      const accessToken = await resolveAccessToken(credentials);

      const response = await fetch(`${GRAPH_API_URL}/me/sendMail`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: {
            subject: "Message",
            body: {
              contentType: "Text",
              content: text,
            },
            toRecipients: [
              {
                emailAddress: { address: recipientId },
              },
            ],
          },
        }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({})) as Record<string, any>;
        console.error("Outlook send error:", errData);
        return null;
      }

      // sendMail returns 202 Accepted with no body
      return crypto.randomUUID();
    } catch (err: any) {
      console.error("Outlook send error:", err.message);
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
      const accessToken = await resolveAccessToken(credentials);

      const buttonHtml = buttons
        .map(
          (b) =>
            `<a href="#" data-id="${b.id}" style="display:inline-block;margin:4px 8px 4px 0;padding:8px 16px;background:#0078d4;color:#fff;text-decoration:none;border-radius:4px;">${b.title}</a>`
        )
        .join("");

      const html = `<p>${bodyText}</p><div>${buttonHtml}</div>`;

      const response = await fetch(`${GRAPH_API_URL}/me/sendMail`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: {
            subject: "Message",
            body: {
              contentType: "HTML",
              content: html,
            },
            toRecipients: [
              {
                emailAddress: { address: recipientId },
              },
            ],
          },
        }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({})) as Record<string, any>;
        console.error("Outlook interactive send error:", errData);
        return null;
      }

      return crypto.randomUUID();
    } catch (err: any) {
      console.error("Outlook interactive send error:", err.message);
      return null;
    }
  },
};

// ─── Helpers ───────────────────────────────────────────────

async function resolveAccessToken(credentials: ChannelCredentials): Promise<string> {
  if (credentials.refreshToken && credentials.clientId && credentials.clientSecret) {
    const tenantId = (credentials.tenantIdAzure as string) || "common";
    const response = await fetch(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: credentials.clientId as string,
          client_secret: credentials.clientSecret as string,
          refresh_token: credentials.refreshToken as string,
          grant_type: "refresh_token",
          scope: "https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send offline_access",
        }),
      }
    );

    if (response.ok) {
      const data = await response.json() as Record<string, any>;
      return data.access_token as string;
    }
  }
  return credentials.accessToken;
}
