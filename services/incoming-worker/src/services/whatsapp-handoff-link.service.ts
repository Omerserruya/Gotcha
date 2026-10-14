/**
 * "Continue on WhatsApp" arriving (website widget, stage B; defaults in
 * docs/product/website-widget.md). The customer pressed the widget's button
 * and sent the pre-filled message carrying a code. When that message reaches
 * the workspace's WhatsApp number:
 *   - the code is claimed once (a forwarded message cannot link twice)
 *   - the website and WhatsApp contacts become one customer (same personId)
 *   - the WhatsApp conversation records where it came from, and the website
 *     chat is closed as "continued on WhatsApp", each pointing at the other
 *     (system events, the inbox's own convention: messageType "system")
 *   - the bot reads the website chat as context from that event, so the
 *     customer is not asked to repeat themselves
 *
 * Best effort: a failure here never costs the inbound message.
 */
import { randomUUID } from "crypto";
import { prisma, getRedis, publishEvent, findHandoffRef, handoffRefKey, handoffConversationKey, type HandoffRecord } from "@chatcenter/shared";

export type HandoffLinkResult =
  | { linked: true; websiteConversationId: string; identity: "linked" | "conflict" }
  /** The WhatsApp kind of widget: no website conversation, the page it started from. */
  | { linked: true; websiteConversationId: null; identity: "none" }
  | { linked: false; reason: "no_code" | "unknown_code" | "other_number" | "website_chat_gone" };

/** Read and delete in one step: only one inbound message can claim a code. */
async function claim(ref: string): Promise<HandoffRecord | null> {
  const out = await getRedis().multi().get(handoffRefKey(ref)).del(handoffRefKey(ref)).exec();
  const raw = out?.[0]?.[1];
  if (typeof raw !== "string") return null;
  try { return JSON.parse(raw) as HandoffRecord; } catch { return null; }
}

export async function linkWebsiteHandoff(args: {
  tenantId: string;
  channelAccountId: string | null | undefined;
  whatsappConversationId: string;
  whatsappContact: { id: string; personId: string | null } | null;
  body: string | null | undefined;
}): Promise<HandoffLinkResult> {
  const ref = findHandoffRef(args.body);
  if (!ref) return { linked: false, reason: "no_code" };
  const record = await claim(ref);
  if (!record) return { linked: false, reason: "unknown_code" };
  // A code is the workspace's and its number's: arriving anywhere else, it
  // links nothing (and stays claimed: it was shown to a customer once).
  if (record.tenantId !== args.tenantId || record.whatsappChannelAccountId !== args.channelAccountId) {
    return { linked: false, reason: "other_number" };
  }
  if (!record.conversationId) {
    // Started on the WhatsApp kind of widget: nothing on the website to link
    // or close. The event records where it came from; the bot reads the page.
    const ctx = record.context ?? null;
    const event = await prisma.message.create({
      data: {
        tenantId: args.tenantId, conversationId: args.whatsappConversationId, channel: "WHATSAPP" as any,
        direction: "INBOUND", body: "", messageType: "system", status: "DELIVERED",
        metadata: {
          systemEvent: "continued_from_website", fromConversationId: null, ref, identity: "none",
          page: ctx ? { pageType: ctx.pageType ?? null, productHandle: ctx.productHandle ?? null, path: ctx.path ?? null } : null,
        },
      },
    });
    await publishEvent({ event: "message:new", tenantId: args.tenantId, data: { message: event, conversationId: args.whatsappConversationId, channel: "WHATSAPP" } }).catch(() => undefined);
    return { linked: true, websiteConversationId: null, identity: "none" };
  }
  const web = await prisma.conversation.findFirst({
    where: { id: record.conversationId, tenantId: args.tenantId, channel: "WEBCHAT" as any },
    select: { id: true, status: true, customerExternalId: true, customerName: true },
  });
  if (!web) return { linked: false, reason: "website_chat_gone" };

  // One customer: the WhatsApp contact's person, else the website one's, else new.
  const webContact = web.customerExternalId
    ? await prisma.contact.findFirst({
        where: { tenantId: args.tenantId, channel: "WEBCHAT" as any, externalId: web.customerExternalId, mergedIntoId: null },
        select: { id: true, personId: true },
      })
    : null;
  let identity: "linked" | "conflict" = "linked";
  const waPerson = args.whatsappContact?.personId ?? null;
  const webPerson = webContact?.personId ?? null;
  if (waPerson && webPerson && waPerson !== webPerson) {
    // Two people already: merging them is a person's decision, not a code's.
    identity = "conflict";
  } else {
    const personId = waPerson ?? webPerson ?? `person_${randomUUID()}`;
    for (const c of [args.whatsappContact, webContact]) {
      if (c && c.personId !== personId) await prisma.contact.update({ where: { id: c.id }, data: { personId } });
    }
  }

  const now = new Date();
  const [toWhatsapp, toWebsite] = await prisma.$transaction([
    prisma.message.create({
      data: {
        tenantId: args.tenantId, conversationId: args.whatsappConversationId, channel: "WHATSAPP" as any,
        direction: "INBOUND", body: "", messageType: "system", status: "DELIVERED",
        metadata: { systemEvent: "continued_from_website", fromConversationId: web.id, ref, identity },
      },
    }),
    prisma.message.create({
      data: {
        tenantId: args.tenantId, conversationId: web.id, channel: "WEBCHAT" as any,
        direction: "INBOUND", body: "", messageType: "system", status: "DELIVERED",
        metadata: { systemEvent: "continued_on_whatsapp", toConversationId: args.whatsappConversationId, ref },
      },
    }),
    prisma.conversation.update({
      where: { id: web.id },
      data: { status: "CLOSED", closedAt: web.status === "CLOSED" ? undefined : now },
    }),
  ]);
  await getRedis().del(handoffConversationKey(web.id)).catch(() => undefined);

  await publishEvent({ event: "message:new", tenantId: args.tenantId, data: { message: toWhatsapp, conversationId: args.whatsappConversationId, channel: "WHATSAPP" } }).catch(() => undefined);
  await publishEvent({ event: "message:new", tenantId: args.tenantId, data: { message: toWebsite, conversationId: web.id, channel: "WEBCHAT" } }).catch(() => undefined);
  await publishEvent({ event: "conversation:closed", tenantId: args.tenantId, data: { conversationId: web.id, reason: "continued_on_whatsapp" } }).catch(() => undefined);
  return { linked: true, websiteConversationId: web.id, identity };
}
