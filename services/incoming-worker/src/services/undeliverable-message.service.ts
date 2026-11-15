/**
 * A WhatsApp message Meta could not deliver to us (`type: "unsupported"`,
 * errors 131051 "Message type unknown" or 131060 "This message is
 * unavailable"). Meta sends no content at all, and the only record of it is
 * the placeholder body "[unsupported message]".
 *
 * Smoovee prod 2026-11-13 09:03: that placeholder reached the AI as if the
 * customer had typed it, and the bot answered "ההודעה נראית כ'לא נתמכת'",
 * our internal word, to a customer who had written "טרם".
 *
 * Now the AI never sees it. While no person owns the conversation, the
 * customer is asked once, gently and in their language, to send it again as
 * text. The reply is the system's (senderName "System"), so the next message
 * is still routed as the conversation's first answerable one.
 *
 * Not asked:
 *  - an album: Meta announces it as unsupported and then delivers each
 *    picture as its own message (prod 2026-11-15 06:29), so nothing is lost;
 *  - any other unmodelled type (a reaction, a deleted message): there is
 *    nothing to resend;
 *  - a second time within ten minutes.
 */
import { prisma, outgoingMessageQueue, publishEvent } from "@chatcenter/shared";

export const RESEND_ASK = {
  he: "נראה שההודעה האחרונה לא הגיעה אלינו. אפשר לשלוח אותה שוב בטקסט?",
  en: "It looks like your last message did not reach us. Could you send it again as text?",
} as const;

export const RESEND_ASK_EVENT = "undeliverable_resend_ask";
export const RESEND_ASK_GAP_MS = 10 * 60_000;

/** What to do with an inbound message: null = an ordinary message. */
export function undeliverableAction(metadata: unknown): null | "ask" | "ignore" {
  const u = (metadata as any)?.unsupported;
  if (!u || typeof u !== "object") return null;
  if (u.providerType !== "unsupported") return "ignore";
  const kind = String(u.raw?.unsupported?.type ?? "").toLowerCase();
  return kind === "album" ? "ignore" : "ask";
}

export function resendAskLanguage(detectedLocale: string | null | undefined): "he" | "en" {
  return String(detectedLocale ?? "").toLowerCase().startsWith("en") ? "en" : "he";
}

/**
 * True when the message was undeliverable and is fully handled here: the
 * worker then stops, and no automation, playbook or AI answers it.
 */
export async function handleUndeliverable(input: {
  tenantId: string;
  conversationId: string;
  channel: string;
  channelAccountId: string | null | undefined;
  recipientExternalId: string;
  metadata: unknown;
  detectedLocale: string | null | undefined;
  /** A person owns the conversation: nothing is sent, the message just sits in the inbox. */
  humanOwned: boolean;
}): Promise<boolean> {
  const action = undeliverableAction(input.metadata);
  if (!action) return false;
  if (action === "ignore" || input.humanOwned || !input.channelAccountId) {
    console.log(`[incoming-worker] undeliverable message conv=${input.conversationId} action=${action === "ignore" ? "ignore" : "none"} (no reply)`);
    return true;
  }
  const recent = await prisma.message.findFirst({
    where: {
      conversationId: input.conversationId,
      direction: "OUTBOUND",
      createdAt: { gte: new Date(Date.now() - RESEND_ASK_GAP_MS) },
      metadata: { path: ["systemEvent"], equals: RESEND_ASK_EVENT },
    } as any,
    select: { id: true },
  });
  if (recent) {
    console.log(`[incoming-worker] undeliverable message conv=${input.conversationId}: asked already within 10 minutes`);
    return true;
  }
  const body = RESEND_ASK[resendAskLanguage(input.detectedLocale)];
  try {
    const reply = await prisma.message.create({
      data: {
        tenantId: input.tenantId, conversationId: input.conversationId, channel: input.channel as any,
        direction: "OUTBOUND", body, messageType: "text", senderName: "System", status: "PENDING",
        metadata: { systemEvent: RESEND_ASK_EVENT },
      } as any,
    });
    await prisma.conversation.update({ where: { id: input.conversationId }, data: { lastMessageAt: new Date() } });
    await outgoingMessageQueue.add("send", {
      tenantId: input.tenantId, conversationId: input.conversationId, channel: input.channel as any,
      channelAccountId: input.channelAccountId, recipientExternalId: input.recipientExternalId,
      body, messageType: "text", senderName: "System", messageId: reply.id,
    }, { attempts: 3, backoff: { type: "exponential", delay: 1000 } });
    await publishEvent({ event: "message:new", tenantId: input.tenantId, data: { message: reply, conversationId: input.conversationId } });
    console.log(`[incoming-worker] undeliverable message conv=${input.conversationId}: asked to resend as text`);
  } catch (err: any) {
    console.error(`[incoming-worker] resend ask failed conv=${input.conversationId}: ${err?.message}`);
  }
  return true;
}
