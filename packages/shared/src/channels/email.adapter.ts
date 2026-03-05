import crypto from "crypto";
import nodemailer from "nodemailer";
import type {
  InboundAdapter,
  OutboundAdapter,
  NormalizedInboundMessage,
  NormalizedStatusUpdate,
  ChannelCredentials,
} from "./types";

// ─── Inbound Adapter ─────────────────────────────────────────

export const emailInboundAdapter: InboundAdapter = {
  channel: "EMAIL",

  canHandle(body: any): boolean {
    return body?.from !== undefined && body?.to !== undefined && body?.subject !== undefined;
  },

  extractMessages(body: any): NormalizedInboundMessage[] {
    const rawFrom: string = (body.envelope?.from || body.from || "") as string;
    const subject: string = body.subject || "";
    const text: string = body.text || "";
    const messageText = subject + "\n" + text;

    // Parse "John Doe <john@example.com>" into name and email
    const nameMatch = rawFrom.match(/^["']?(.+?)["']?\s*<(.+?)>$/);
    const senderId = nameMatch ? nameMatch[2] : rawFrom;
    const senderDisplayName = nameMatch ? nameMatch[1].trim() : undefined;

    return [
      {
        externalMessageId: crypto.randomUUID(),
        channel: "EMAIL",
        senderId,
        senderDisplayName,
        timestamp: new Date(),
        content: {
          type: "text",
          text: messageText,
        },
      },
    ];
  },

  extractStatusUpdates(_payload: any): NormalizedStatusUpdate[] {
    return [];
  },

  resolveChannelAccountExternalId(body: any): string | null {
    if (body.envelope?.to) {
      const to = body.envelope.to;
      if (Array.isArray(to)) {
        return to[0] || null;
      }
      return to as string;
    }
    if (body.to) {
      const to = body.to;
      if (Array.isArray(to)) {
        return to[0] || null;
      }
      return to as string;
    }
    return null;
  },

  verifySignature(appSecret: string, rawBody: Buffer, signature: string): boolean {
    const expectedSig = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
    try {
      return crypto.timingSafeEqual(Buffer.from(expectedSig), Buffer.from(signature));
    } catch {
      return false;
    }
  },

  getSignatureHeader(): string {
    return "x-webhook-signature";
  },
};

// ─── Outbound Adapter ────────────────────────────────────────

export const emailOutboundAdapter: OutboundAdapter = {
  channel: "EMAIL",

  async sendTextMessage(
    credentials: ChannelCredentials,
    accountExternalId: string,
    recipientId: string,
    text: string
  ): Promise<string | null> {
    try {
      const transporter = nodemailer.createTransport({
        host: credentials.smtpHost as string,
        port: credentials.smtpPort as number,
        auth: {
          user: credentials.smtpUser as string,
          pass: credentials.smtpPass as string,
        },
      });

      const fromAddress = (credentials.fromAddress as string) || accountExternalId;
      const info = await transporter.sendMail({
        from: fromAddress,
        to: recipientId,
        text,
      });

      return info.messageId || crypto.randomUUID();
    } catch (err: any) {
      console.error("Email send error:", err.message);
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
    try {
      const transporter = nodemailer.createTransport({
        host: credentials.smtpHost as string,
        port: credentials.smtpPort as number,
        auth: {
          user: credentials.smtpUser as string,
          pass: credentials.smtpPass as string,
        },
      });

      const buttonHtml = buttons
        .map(
          (b) =>
            `<a href="#" data-id="${b.id}" style="display:inline-block;margin:4px 8px 4px 0;padding:8px 16px;background:#007bff;color:#fff;text-decoration:none;border-radius:4px;">${b.title}</a>`
        )
        .join("");

      const html = `<p>${bodyText}</p><div>${buttonHtml}</div>`;

      const fromAddress = (credentials.fromAddress as string) || accountExternalId;
      const info = await transporter.sendMail({
        from: fromAddress,
        to: recipientId,
        html,
      });

      return info.messageId || crypto.randomUUID();
    } catch (err: any) {
      console.error("Email interactive send error:", err.message);
      return null;
    }
  },
};
