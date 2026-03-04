import crypto from "crypto";
import type {
  InboundAdapter,
  OutboundAdapter,
  NormalizedInboundMessage,
  NormalizedStatusUpdate,
  ChannelCredentials,
} from "./types";

// ─── Gmail Inbound Adapter ─────────────────────────────────

export const gmailInboundAdapter: InboundAdapter = {
  channel: "GMAIL",

  canHandle(body: any): boolean {
    // Google Pub/Sub push notification format
    return body?.message?.data !== undefined && body?.subscription !== undefined;
  },

  extractMessages(body: any): NormalizedInboundMessage[] {
    // Google Pub/Sub delivers a base64-encoded notification with historyId
    // The actual message content is fetched via Gmail API by the incoming worker
    // Here we extract the notification metadata
    try {
      const pubsubData = JSON.parse(
        Buffer.from(body.message.data, "base64").toString("utf8")
      );
      const emailAddress = pubsubData.emailAddress || "";
      const historyId = pubsubData.historyId || "";

      return [
        {
          externalMessageId: body.message.messageId || crypto.randomUUID(),
          channel: "GMAIL",
          senderId: emailAddress,
          timestamp: new Date(),
          content: {
            type: "text",
            text: `[Gmail notification: historyId=${historyId}]`,
          },
        },
      ];
    } catch {
      return [];
    }
  },

  extractStatusUpdates(_payload: any): NormalizedStatusUpdate[] {
    return [];
  },

  resolveChannelAccountExternalId(body: any): string | null {
    try {
      const pubsubData = JSON.parse(
        Buffer.from(body.message.data, "base64").toString("utf8")
      );
      return pubsubData.emailAddress || null;
    } catch {
      return null;
    }
  },

  verifySignature(_appSecret: string, _rawBody: Buffer, _signature: string): boolean {
    // Google Pub/Sub push endpoints are verified via subscription setup
    // and authenticated via the OAuth token in the Authorization header.
    // No HMAC signature verification is used.
    return true;
  },

  getSignatureHeader(): string {
    return "authorization";
  },
};

// ─── Gmail Outbound Adapter ────────────────────────────────

const GMAIL_API_URL = "https://gmail.googleapis.com/gmail/v1";

export const gmailOutboundAdapter: OutboundAdapter = {
  channel: "GMAIL",

  async sendTextMessage(
    credentials: ChannelCredentials,
    accountExternalId: string,
    recipientId: string,
    text: string
  ): Promise<string | null> {
    try {
      const accessToken = await resolveAccessToken(credentials);

      const fromAddress = (credentials.fromAddress as string) || accountExternalId;
      const rawMessage = buildRawEmail(fromAddress, recipientId, "Message", text);

      const response = await fetch(`${GMAIL_API_URL}/users/me/messages/send`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ raw: rawMessage }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({})) as Record<string, any>;
        console.error("Gmail send error:", errData);
        return null;
      }

      const data = await response.json() as Record<string, any>;
      return (data.id as string) || crypto.randomUUID();
    } catch (err: any) {
      console.error("Gmail send error:", err.message);
      return null;
    }
  },

  async sendInteractiveMessage(
    credentials: ChannelCredentials,
    accountExternalId: string,
    recipientId: string,
    bodyText: string,
    buttons: Array<{ id: string; title: string }>
  ): Promise<string | null> {
    // Gmail doesn't support interactive buttons natively; send as HTML with styled links
    try {
      const accessToken = await resolveAccessToken(credentials);

      const buttonHtml = buttons
        .map(
          (b) =>
            `<a href="#" data-id="${b.id}" style="display:inline-block;margin:4px 8px 4px 0;padding:8px 16px;background:#007bff;color:#fff;text-decoration:none;border-radius:4px;">${b.title}</a>`
        )
        .join("");

      const html = `<p>${bodyText}</p><div>${buttonHtml}</div>`;
      const fromAddress = (credentials.fromAddress as string) || accountExternalId;
      const rawMessage = buildRawHtmlEmail(fromAddress, recipientId, "Message", html);

      const response = await fetch(`${GMAIL_API_URL}/users/me/messages/send`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ raw: rawMessage }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({})) as Record<string, any>;
        console.error("Gmail interactive send error:", errData);
        return null;
      }

      const data = await response.json() as Record<string, any>;
      return (data.id as string) || crypto.randomUUID();
    } catch (err: any) {
      console.error("Gmail interactive send error:", err.message);
      return null;
    }
  },
};

// ─── Helpers ───────────────────────────────────────────────

async function resolveAccessToken(credentials: ChannelCredentials): Promise<string> {
  // If we have a refresh token, exchange it for a fresh access token
  if (credentials.refreshToken && credentials.clientId && credentials.clientSecret) {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: credentials.clientId as string,
        client_secret: credentials.clientSecret as string,
        refresh_token: credentials.refreshToken as string,
        grant_type: "refresh_token",
      }),
    });

    if (response.ok) {
      const data = await response.json() as Record<string, any>;
      return data.access_token as string;
    }
  }
  return credentials.accessToken;
}

function buildRawEmail(from: string, to: string, subject: string, body: string): string {
  const message = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\r\n");

  return Buffer.from(message).toString("base64url");
}

function buildRawHtmlEmail(from: string, to: string, subject: string, html: string): string {
  const message = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=utf-8",
    "",
    html,
  ].join("\r\n");

  return Buffer.from(message).toString("base64url");
}
