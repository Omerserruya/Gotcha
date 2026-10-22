/**
 * The ONE place a channel's HTML email template is applied (2026-10-22).
 *
 * Every outgoing email - an agent's reply from the inbox, the AI's reply, an
 * automation's email, a scheduled send, a broadcast - reaches a provider
 * through an email adapter's `sendTextMessage`, and every producer gets that
 * adapter from the registry. So the registry wraps the three email adapters
 * with this, rather than each producer remembering to: the AI bot alone calls
 * the adapter from five places, and the next producer added would forget.
 *
 * What the wrapper does:
 *   - looks up the sending channel account (channel + externalId is unique),
 *     reads its template (a durable tenant setting), and, when it is on,
 *     renders it around the message: {{content}} = the text as HTML.
 *   - hands the adapter `thread.htmlBody` NEXT TO the unchanged text, so the
 *     adapter sends both parts (multipart/alternative) and the plain text stays.
 *   - leaves the threading fields exactly as they came in.
 *
 * Applied once: a context that already carries `htmlBody` is passed through
 * untouched, so a wrapped adapter wrapped again cannot double-wrap.
 *
 * Never blocks a send: any failure here (no account row, unreadable setting,
 * database down) logs and sends the plain message, as before this existed.
 *
 * GOTCHA's own system mail (sign-up, receipts, alerts) does not come through
 * here at all: it is sent by the notifications service with brand-email.ts.
 */
import { prisma } from "../lib/prisma";
import { readDurableSetting } from "../lib/durable-settings";
import {
  emailTemplateKey,
  parseStoredEmailTemplate,
  renderEmailTemplate,
  textToEmailHtml,
} from "../lib/email/email-template";
import type { EmailThreadContext } from "./email-thread";
import type { ChannelType, OutboundAdapter } from "./types";

export const TEMPLATED_EMAIL_CHANNELS: ReadonlySet<ChannelType> = new Set(["EMAIL", "GMAIL", "OUTLOOK"] as ChannelType[]);

export interface EmailHtmlInput {
  channel: ChannelType;
  accountExternalId: string;
  recipient: string;
  text: string;
  thread?: EmailThreadContext;
}

/**
 * The HTML to send for this email, or null to send the plain text alone.
 * `thread.templateOverride` (the test send) renders that template even while
 * the stored one is switched off.
 */
export async function emailHtmlFor(input: EmailHtmlInput): Promise<string | null> {
  const account = await prisma.channelAccount.findUnique({
    where: { channel_externalId: { channel: input.channel, externalId: input.accountExternalId } },
    select: { id: true, tenantId: true, tenant: { select: { name: true } } },
  });
  if (!account) return null;

  let template: string | null = input.thread?.templateOverride ?? null;
  if (template === null) {
    const stored = parseStoredEmailTemplate(await readDurableSetting(account.tenantId, emailTemplateKey(account.id)));
    if (!stored || !stored.enabled) return null;
    template = stored.html;
  }

  const customerName = input.thread?.customerName
    ?? (await prisma.contact
      .findFirst({
        where: { tenantId: account.tenantId, email: { equals: input.recipient, mode: "insensitive" } },
        select: { displayName: true },
      })
      .catch(() => null))?.displayName
    ?? null;

  return renderEmailTemplate(template, {
    contentHtml: textToEmailHtml(input.text),
    agentName: input.thread?.senderName ?? account.tenant?.name ?? null,
    businessName: account.tenant?.name ?? null,
    customerName,
  });
}

/** Wrap an email adapter so its text sends carry the channel's template. */
export function withEmailTemplate(channel: ChannelType, adapter: OutboundAdapter): OutboundAdapter {
  const send = adapter.sendTextMessage.bind(adapter);
  return {
    ...adapter,
    async sendTextMessage(credentials, accountExternalId, recipientId, text, replyToExternalId, thread) {
      if (thread?.htmlBody !== undefined) {
        return send(credentials, accountExternalId, recipientId, text, replyToExternalId, thread);
      }
      let html: string | null = null;
      try {
        html = await emailHtmlFor({ channel, accountExternalId, recipient: recipientId, text, thread });
      } catch (err: any) {
        console.warn(`[email-template] not applied (${channel}): ${err?.message}`);
      }
      const ctx: EmailThreadContext | undefined = html === null
        ? thread
        : { ...(thread ?? { subject: "" }), htmlBody: html };
      return send(credentials, accountExternalId, recipientId, text, replyToExternalId, ctx);
    },
  };
}
