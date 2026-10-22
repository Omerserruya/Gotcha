import crypto from "crypto";
import type {
  InboundAdapter,
  OutboundAdapter,
  NormalizedInboundMessage,
  NormalizedStatusUpdate,
  ChannelCredentials,
} from "./types";
import { type EmailThreadContext, outgoingSubject, parseMessageIdList, type EmailMessageMeta } from "./email-thread";
import { autoMailReason } from "./auto-mail";

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

      // Only the notification: the message itself is fetched by the webhook
      // route with fetchOutlookMessage (2026-10-14). This placeholder shape is
      // kept for callers that only need to know a message arrived.
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
    // included in the subscription creation request; the clientState is sent
    // back in every notification. Route-level verification uses
    // verifySharedSecretToken against OUTLOOK_WEBHOOK_CLIENT_STATE; this method
    // stays fail-closed so it is never a bypass if called directly.
    if (!signature || !_appSecret) return false;
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
    text: string,
    _replyToExternalId?: string,
    thread?: EmailThreadContext,
  ): Promise<string | null> {
    try {
      const accessToken = await resolveAccessToken(credentials);

      // Graph's own reply endpoint is the reliable path: it copies the subject,
      // the recipients and the whole threading header set off the original, so
      // the reply lands in the customer's existing conversation instead of
      // beside it. Only available when we recorded which message we are
      // answering.
      if (thread?.providerMessageId) {
        const replyRes = await fetch(
          `${GRAPH_API_URL}/me/messages/${encodeURIComponent(thread.providerMessageId)}/reply`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ comment: text }),
          },
        );
        if (replyRes.ok) return crypto.randomUUID();
        const replyErr = await replyRes.json().catch(() => ({})) as Record<string, any>;
        // Fall through to a normal send rather than dropping the agent's reply:
        // an un-threaded answer still reaches the customer, silence does not.
        console.error("Outlook reply error, falling back to sendMail:", replyErr);
      }

      // thread.extraHeaders (List-Unsubscribe on marketing mail) are NOT sent
      // here: Graph's sendMail accepts only custom "X-" headers, so a marketing
      // email from Outlook carries the removal line in its text only.
      const internetHeaders = [
        ...(thread?.inReplyTo ? [{ name: "In-Reply-To", value: thread.inReplyTo }] : []),
        ...(thread?.references?.length ? [{ name: "References", value: thread.references.join(" ") }] : []),
      ];

      const response = await fetch(`${GRAPH_API_URL}/me/sendMail`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: {
            subject: outgoingSubject(thread),
            body: {
              contentType: "Text",
              content: text,
            },
            toRecipients: [
              {
                emailAddress: { address: recipientId },
              },
            ],
            // Graph only accepts custom internet headers whose name starts with
            // "x-" EXCEPT for a small allow-list that includes the threading
            // pair, which is precisely why they can be set here.
            ...(internetHeaders.length ? { internetMessageHeaders: internetHeaders } : {}),
            ...(thread?.threadId ? { conversationId: thread.threadId } : {}),
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

// ─── Inbound: the message a notification is about (2026-10-14) ──────────────
//
// A Graph notification names a message and carries nothing else useful: the
// route used to queue its Graph path as the sender and "[Outlook
// notification]" as the text. This reads the message itself: the real sender,
// subject and text, and the ids a reply needs (internetMessageId and
// References for the headers, conversationId and the Graph id for Outlook's
// own reply), the same EmailMessageMeta the Gmail path stores.

export interface OutlookFetchedMessage {
  messageId: string;
  senderId: string;
  senderDisplayName?: string;
  subject: string;
  body: string;
  email: EmailMessageMeta;
}

const MAX_INBOUND_BODY = 20_000;

/**
 * The message, or why it was not taken: "not_found", "draft", "self" (the
 * account's own mail), or an auto-generated mail's reason (bounce, report,
 * auto-reply, bulk).
 */
export async function fetchOutlookMessage(
  credentials: ChannelCredentials,
  messageId: string,
  accountEmail: string,
): Promise<{ ok: true; message: OutlookFetchedMessage } | { ok: false; reason: string }> {
  const accessToken = await resolveAccessToken(credentials);
  const select = "from,sender,subject,bodyPreview,body,uniqueBody,internetMessageId,conversationId,internetMessageHeaders,isDraft";
  const res = await fetch(`${GRAPH_API_URL}/me/messages/${encodeURIComponent(messageId)}?$select=${select}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Prefer: 'outlook.body-content-type="text"' },
  });
  if (!res.ok) {
    console.error(`[Outlook] message ${messageId} could not be read: ${res.status}`);
    return { ok: false, reason: "not_found" };
  }
  const m = (await res.json()) as Record<string, any>;
  if (m.isDraft) return { ok: false, reason: "draft" };
  const fromAddr = String(m.from?.emailAddress?.address ?? m.sender?.emailAddress?.address ?? "").trim();
  const fromName = String(m.from?.emailAddress?.name ?? "").trim();
  if (!fromAddr) return { ok: false, reason: "not_found" };
  if (accountEmail && fromAddr.toLowerCase() === accountEmail.toLowerCase()) return { ok: false, reason: "self" };

  const headerList: Array<{ name: string; value: string }> = Array.isArray(m.internetMessageHeaders) ? m.internetMessageHeaders : [];
  const headers = Object.fromEntries(headerList.map((h) => [h.name, h.value]));
  const header = (name: string) => headerList.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
  const auto = autoMailReason({ headers, from: fromAddr });
  if (auto) return { ok: false, reason: auto };

  const subject = String(m.subject ?? "").trim() || "(no subject)";
  // The new text of a reply when Graph can tell it apart, else the whole body.
  const body = String(m.uniqueBody?.content ?? m.body?.content ?? m.bodyPreview ?? "").trim().slice(0, MAX_INBOUND_BODY);
  const references = [...parseMessageIdList(header("References")), ...parseMessageIdList(header("In-Reply-To"))]
    .filter((id, i, all) => all.indexOf(id) === i);
  return {
    ok: true,
    message: {
      messageId: String(m.id ?? messageId),
      senderId: fromAddr,
      ...(fromName && fromName !== fromAddr ? { senderDisplayName: fromName } : {}),
      subject,
      body,
      email: {
        messageIdHeader: parseMessageIdList(String(m.internetMessageId ?? ""))[0],
        references,
        subject,
        threadId: typeof m.conversationId === "string" ? m.conversationId : undefined,
        providerMessageId: String(m.id ?? messageId),
      },
    },
  };
}
