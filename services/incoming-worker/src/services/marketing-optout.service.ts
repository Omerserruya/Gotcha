/**
 * A customer's "הסר" / "STOP" reply: no more marketing on that channel.
 *
 * Marketing works by opt-out here (Omer's decision 2026-10-08, docs/product/
 * ai-studio-skills-automations.md §6), so this reply is the customer's one
 * control and must always work: whoever owns the conversation, whatever runs
 * on it. It records the opt-out on the contact (read by every marketing gate,
 * an opt-out always wins), appends a consent withdrawal and an audit entry,
 * and answers with a short confirmation. Nothing else answers that message.
 */
import { prisma, outgoingMessageQueue, publishEvent, auditSystem, AuditAction } from "@chatcenter/shared";
import { OPT_OUT_CONFIRMATION, OPT_IN_CONFIRMATION, isOptedOutOn, optOutReply, optInReply } from "@chatcenter/shared/src/lib/marketing-optout";

export interface OptOutInput {
  tenantId: string;
  contactId: string;
  channel: string;
  conversationId: string;
  channelAccountId: string | null | undefined;
  recipientExternalId: string;
  messageId: string;
  language: "he" | "en";
}

export async function applyMarketingOptOut(input: OptOutInput): Promise<{ alreadyOptedOut: boolean }> {
  const channel = String(input.channel).toUpperCase();
  const contact = await prisma.contact.findFirst({
    where: { id: input.contactId, tenantId: input.tenantId },
    select: { id: true, optOutChannels: true },
  });
  if (!contact) return { alreadyOptedOut: false };
  const current = Array.isArray(contact.optOutChannels) ? (contact.optOutChannels as unknown[]).map((x) => String(x).toUpperCase()) : [];
  const alreadyOptedOut = isOptedOutOn(current, channel);

  if (!alreadyOptedOut) {
    await prisma.contact.update({
      where: { id: contact.id },
      data: { optOutChannels: [...current, channel], optedOutAt: new Date() } as any,
    });
  }
  // The consent ledger is append-only: a withdrawal is a new row.
  await prisma.consentRecord.create({
    data: {
      tenantId: input.tenantId, subjectType: "contact", subjectId: contact.id,
      purpose: `marketing_${channel.toLowerCase()}`, granted: false, source: "reply_keyword",
      evidence: { channel, messageId: input.messageId, conversationId: input.conversationId },
    },
  }).catch((err: any) => console.warn(`[marketing-optout] consent record failed contact=${contact.id}: ${err?.message}`));
  await auditSystem(input.tenantId, AuditAction.CONSENT_WITHDRAWN, { type: "contact", id: contact.id }, {
    purpose: `marketing_${channel.toLowerCase()}`, source: "reply_keyword", channel, messageId: input.messageId, alreadyOptedOut,
  });

  await confirm(input, OPT_OUT_CONFIRMATION[input.language], "marketing_opt_out_confirmation");
  console.log(`[marketing-optout] contact=${contact.id} channel=${channel} ${alreadyOptedOut ? "already opted out" : "opted out"}`);
  return { alreadyOptedOut };
}

/** "START" / "הצטרף" from a customer opted out on this channel: marketing may resume. */
export async function applyMarketingOptIn(input: OptOutInput): Promise<boolean> {
  const channel = String(input.channel).toUpperCase();
  const contact = await prisma.contact.findFirst({
    where: { id: input.contactId, tenantId: input.tenantId },
    select: { id: true, optOutChannels: true },
  });
  if (!contact || !isOptedOutOn(contact.optOutChannels, channel)) return false;
  const remaining = (contact.optOutChannels as unknown[]).map((x) => String(x)).filter((x) => x.toUpperCase() !== channel);
  await prisma.contact.update({
    where: { id: contact.id },
    data: { optOutChannels: remaining, ...(remaining.length ? {} : { optedOutAt: null }) } as any,
  });
  await prisma.consentRecord.create({
    data: {
      tenantId: input.tenantId, subjectType: "contact", subjectId: contact.id,
      purpose: `marketing_${channel.toLowerCase()}`, granted: true, source: "reply_keyword",
      evidence: { channel, messageId: input.messageId, conversationId: input.conversationId },
    },
  }).catch((err: any) => console.warn(`[marketing-optout] consent record failed contact=${contact.id}: ${err?.message}`));
  await auditSystem(input.tenantId, AuditAction.CONSENT_GRANTED, { type: "contact", id: contact.id }, {
    purpose: `marketing_${channel.toLowerCase()}`, source: "reply_keyword", channel, messageId: input.messageId,
  });
  await confirm(input, OPT_IN_CONFIRMATION[input.language], "marketing_opt_in_confirmation");
  console.log(`[marketing-optout] contact=${contact.id} channel=${channel} opted back in`);
  return true;
}

/** The short confirmation: the customer just wrote, so free text is allowed on every channel. */
async function confirm(input: OptOutInput, body: string, systemEvent: string): Promise<void> {
  if (input.channelAccountId) {
    try {
      const reply = await prisma.message.create({
        data: {
          tenantId: input.tenantId, conversationId: input.conversationId, channel: input.channel as any,
          direction: "OUTBOUND", body, messageType: "text", senderName: "System", status: "PENDING",
          metadata: { systemEvent },
        } as any,
      });
      await prisma.conversation.update({ where: { id: input.conversationId }, data: { lastMessageAt: new Date() } });
      await outgoingMessageQueue.add("send", {
        tenantId: input.tenantId, conversationId: input.conversationId, channel: input.channel as any,
        channelAccountId: input.channelAccountId, recipientExternalId: input.recipientExternalId,
        body, messageType: "text", senderName: "System", messageId: reply.id,
      }, { attempts: 3, backoff: { type: "exponential", delay: 1000 } });
      await publishEvent({ event: "message:new", tenantId: input.tenantId, data: { message: reply, conversationId: input.conversationId } });
    } catch (err: any) {
      console.error(`[marketing-optout] confirmation failed conv=${input.conversationId}: ${err?.message}`);
    }
  }
}

/**
 * The inbound check: true when the message was an opt-out (or, from an
 * opted-out customer, an opt-in) reply and has been handled (the worker then
 * stops: nothing else answers it).
 */
export async function interceptOptOutReply(input: Omit<OptOutInput, "language"> & { messageType: string; body: string | null | undefined }): Promise<boolean> {
  if (input.messageType !== "text" || !input.contactId) return false;
  const { messageType: _t, body: _b, ...rest } = input;
  const out = optOutReply(input.body);
  if (out) { await applyMarketingOptOut({ ...rest, language: out }); return true; }
  // Opting back in counts only when the customer is opted out here;
  // otherwise "start" is an ordinary message and goes on to be answered.
  const back = optInReply(input.body);
  if (back) return applyMarketingOptIn({ ...rest, language: back });
  return false;
}
