import crypto from "crypto";
import type {
  InboundAdapter,
  OutboundAdapter,
  NormalizedInboundMessage,
  NormalizedStatusUpdate,
  ChannelCredentials,
} from "./types";
import {
  type EmailThreadContext,
  type EmailMessageMeta,
  outgoingSubject,
  parseMessageIdList,
  threadHeaderLines,
} from "./email-thread";

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
    // Google Pub/Sub push carries no reproducible HMAC. The Gmail route verifies
    // a shared push token (verifySharedSecretToken against GMAIL_PUBSUB_TOKEN),
    // which is the authoritative check. This stub stays fail-closed so it can
    // never act as a silent bypass if a future caller wires it in.
    return false;
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
    text: string,
    _replyToExternalId?: string,
    thread?: EmailThreadContext,
  ): Promise<string | null> {
    try {
      const accessToken = await resolveAccessToken(credentials);

      const fromAddress = (credentials.fromAddress as string) || accountExternalId;
      const rawMessage = buildRawEmail(
        fromAddress,
        recipientId,
        outgoingSubject(thread),
        text,
        threadHeaderLines(thread),
      );

      const response = await fetch(`${GMAIL_API_URL}/users/me/messages/send`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        // threadId is Gmail's own answer to "which conversation". The headers
        // above are what every other mail client in the chain reads. Sending
        // one without the other threads the message on one side only.
        body: JSON.stringify({ raw: rawMessage, ...(thread?.threadId ? { threadId: thread.threadId } : {}) }),
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
    buttons: Array<{ id: string; title: string }>,
    thread?: EmailThreadContext,
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
      const rawMessage = buildRawHtmlEmail(
        fromAddress,
        recipientId,
        outgoingSubject(thread),
        html,
        threadHeaderLines(thread),
      );

      const response = await fetch(`${GMAIL_API_URL}/users/me/messages/send`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ raw: rawMessage, ...(thread?.threadId ? { threadId: thread.threadId } : {}) }),
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

// ─── Exported helpers ──────────────────────────────────────

export interface GmailFetchedMessage {
  messageId: string;
  senderId: string;
  senderDisplayName: string;
  subject: string;
  body: string;
  /**
   * Everything needed to answer this email in its own thread later.
   *
   * Captured on the way in because it cannot be recovered on the way out: by
   * the time an agent types a reply, the only trace of the customer's original
   * Message-ID is whatever we wrote down when it arrived.
   */
  email: EmailMessageMeta;
}

/**
 * Fetch new messages from Gmail using the History API.
 * Calls history.list with startHistoryId, then fetches metadata for each new message.
 * Filters out SENT messages (only returns INBOX).
 */
export async function fetchNewMessages(
  credentials: ChannelCredentials,
  lastHistoryId: string,
  accountEmail: string
): Promise<{ messages: GmailFetchedMessage[]; newHistoryId: string }> {
  const accessToken = await resolveAccessToken(credentials);
  const headers = { Authorization: `Bearer ${accessToken}` };

  // 1. Get history since lastHistoryId
  const historyUrl = `${GMAIL_API_URL}/users/me/history?startHistoryId=${lastHistoryId}&historyTypes=messageAdded`;
  const historyRes = await fetch(historyUrl, { headers });

  if (!historyRes.ok) {
    const err = await historyRes.json().catch(() => ({})) as Record<string, any>;
    // 404 means historyId is too old - caller should reset
    console.error("[Gmail] History fetch error:", historyRes.status, err);
    return { messages: [], newHistoryId: lastHistoryId };
  }

  const historyData = await historyRes.json() as Record<string, any>;
  const newHistoryId = (historyData.historyId as string) || lastHistoryId;

  if (!historyData.history || !Array.isArray(historyData.history)) {
    return { messages: [], newHistoryId };
  }

  // 2. Collect unique message IDs from messagesAdded
  const seenIds = new Set<string>();
  for (const entry of historyData.history) {
    if (entry.messagesAdded) {
      for (const added of entry.messagesAdded) {
        const msg = added.message;
        if (!msg?.id) continue;
        // Skip messages with SENT label (outbound)
        const labels: string[] = msg.labelIds || [];
        if (labels.includes("SENT")) continue;
        if (!labels.includes("INBOX")) continue;
        seenIds.add(msg.id);
      }
    }
  }

  if (seenIds.size === 0) {
    return { messages: [], newHistoryId };
  }

  // 3. Fetch metadata for each message
  const results: GmailFetchedMessage[] = [];
  for (const msgId of seenIds) {
    try {
      const msgRes = await fetch(
        // Message-ID / References / In-Reply-To are requested here and nowhere
        // else: they are the only way a later reply can rejoin this thread.
        `${GMAIL_API_URL}/users/me/messages/${msgId}?format=metadata` +
          "&metadataHeaders=From&metadataHeaders=Subject" +
          "&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=In-Reply-To",
        { headers }
      );
      if (!msgRes.ok) continue;

      const msgData = await msgRes.json() as Record<string, any>;
      const headersArr: Array<{ name: string; value: string }> = msgData.payload?.headers || [];
      // Header names are case-insensitive per RFC 5322, and Gmail does return
      // "Message-Id" for some senders. Matching exactly on "Message-ID" would
      // silently drop threading for those.
      const header = (name: string): string =>
        headersArr.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";

      const fromHeader = header("From");
      const subject = header("Subject") || "(no subject)";
      const snippet = (msgData.snippet as string) || "";

      const { email, name } = parseFromHeader(fromHeader);

      // Skip if sender is the account itself (self-sent)
      if (email.toLowerCase() === accountEmail.toLowerCase()) continue;

      const messageIdHeader = parseMessageIdList(header("Message-ID"))[0];
      // The chain to inherit: what this email referenced, plus what it was a
      // direct reply to, in case a sender set only In-Reply-To.
      const references = [
        ...parseMessageIdList(header("References")),
        ...parseMessageIdList(header("In-Reply-To")),
      ].filter((id, i, all) => all.indexOf(id) === i);

      results.push({
        messageId: msgId,
        senderId: email,
        senderDisplayName: name,
        subject,
        body: snippet,
        email: {
          messageIdHeader,
          references,
          subject,
          threadId: typeof msgData.threadId === "string" ? msgData.threadId : undefined,
          providerMessageId: msgId,
        },
      });
    } catch (err) {
      console.error(`[Gmail] Failed to fetch message ${msgId}:`, err);
    }
  }

  return { messages: results, newHistoryId };
}

/**
 * Parse a From header like "John Doe <john@example.com>" into name and email.
 */
function parseFromHeader(from: string): { email: string; name: string } {
  const match = from.match(/^"?(.+?)"?\s*<(.+?)>$/);
  if (match) {
    return { name: match[1].trim(), email: match[2].trim() };
  }
  // Bare email address
  return { name: from.trim(), email: from.trim() };
}

export async function resolveAccessToken(credentials: ChannelCredentials): Promise<string> {
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

/**
 * Subjects are encoded rather than written raw.
 *
 * A raw MIME header is US-ASCII. A Hebrew subject line (or a customer's name
 * with an accent) written straight into the header is mangled by the receiving
 * client, and a newline in one would let a crafted subject inject headers of
 * its own. RFC 2047 base64 encoding solves both.
 */
function encodeSubject(subject: string): string {
  const clean = subject.replace(/[\r\n]+/g, " ").trim();
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

function buildRawEmail(from: string, to: string, subject: string, body: string, extraHeaders: string[] = []): string {
  const message = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    ...extraHeaders,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\r\n");

  return Buffer.from(message).toString("base64url");
}

function buildRawHtmlEmail(from: string, to: string, subject: string, html: string, extraHeaders: string[] = []): string {
  const message = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    ...extraHeaders,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=utf-8",
    "",
    html,
  ].join("\r\n");

  return Buffer.from(message).toString("base64url");
}
