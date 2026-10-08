/**
 * Reading one conversation for the assistant: by its id, by a customer (their
 * id from system_find_customers, or their name), or the one selected in
 * Ctrl+K. Omer's thread found the customer and could not open their
 * conversation (2026-10-08).
 *
 * Every id goes through the by-id rule of the app (the tenant, then the
 * inbox's visibilityClause: canViewConversation / requireVisibleConversation's
 * rule, in this one query) and fails closed without a viewer;
 * private numbers (lib/private-numbers) read as not found too. A conversation
 * the caller cannot open in the inbox does not exist here.
 */
import { prisma, REAL_CONVERSATION, visibilityClause, type Viewer } from "@chatcenter/shared";
import { channelName, whenText } from "./system-tools.service";
import { tenantTimeZone, customerKeys, customerDisplayName, RECORD_SHOWN_AS, cardsOf } from "./assistant-query.service";
import { findCustomers } from "./assistant-customers.service";
import { privateNumbers, conversationIsPrivate, privateConversationsClause } from "../lib/private-numbers";
import { summaryFields } from "../lib/summary-fields";

type Locale = "he" | "en";

export interface ReadCtx {
  tenantId: string;
  viewer?: Viewer;
  locale: Locale;
  nextId: (kind: "b" | "s") => string;
  canReadContacts: boolean;
  /** Ctrl+K only: the conversation open on screen. */
  selectedConversationId?: string | null;
}

export interface ReadArgs { conversationId?: string; customerId?: string; customer?: string[]; limit?: number }

const STATE: Record<string, Record<Locale, string>> = {
  OPEN: { he: "פתוחה", en: "Open" }, WAITING: { he: "ממתינה ללקוח", en: "Waiting for the customer" }, CLOSED: { he: "סגורה", en: "Closed" },
};

/** The conversation if this caller may open it in the inbox; else null (as if it did not exist). */
async function visibleConversation(ctx: ReadCtx, id: string) {
  if (!ctx.viewer?.userId) return null;
  const clause = visibilityClause(ctx.viewer);
  const c = await prisma.conversation.findFirst({
    // tenantId first and always; the clause narrows within it.
    where: { id, tenantId: ctx.tenantId, ...(clause ? { OR: clause } : {}) },
    select: { id: true, channel: true, customerExternalId: true, customerName: true, channelAccountId: true, status: true, handledBy: true, isHandedOver: true, createdAt: true, lastMessageAt: true, assignedAgent: { select: { name: true } } },
  });
  if (!c || conversationIsPrivate(c as any, await privateNumbers(ctx.tenantId))) return null;
  return c;
}

/** A customer's conversation to read: their latest the caller can see, an open one first. */
async function customersConversation(ctx: ReadCtx, contactId: string): Promise<string | null> {
  const keys = await customerKeys(ctx.tenantId, [contactId]);
  if (!keys.length || !ctx.viewer?.userId) return null;
  const clause = visibilityClause(ctx.viewer);
  const priv = privateConversationsClause(await privateNumbers(ctx.tenantId));
  const rows = await prisma.conversation.findMany({
    where: { tenantId: ctx.tenantId, ...REAL_CONVERSATION, AND: [{ OR: keys }, ...(clause ? [{ OR: clause }] : []), ...(priv ? [priv] : [])] } as any,
    select: { id: true, status: true },
    orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { id: "desc" }] as any,
    take: 20,
  });
  return (rows.find((r) => r.status === "OPEN") ?? rows[0])?.id ?? null;
}

export async function readConversationResult(ctx: ReadCtx, args: ReadArgs): Promise<{ summary: Record<string, unknown>; blocks?: unknown[]; source?: unknown }> {
  const he = ctx.locale === "he";
  let id = typeof args.conversationId === "string" && args.conversationId ? args.conversationId : null;

  if (!id && (args.customerId || args.customer?.length)) {
    let contactId = args.customerId ?? null;
    if (!contactId) {
      const spellings = (args.customer ?? []).map(String).filter(Boolean).slice(0, 4);
      const found = await findCustomers(ctx, spellings);
      if (!found.length) {
        return { summary: spellings.length === 1
          ? { ok: true, found: 0, retry: "search again with the name in the other script (Hebrew or Latin letters) and the first name alone (customer: [...]) before saying the customer was not found" }
          : { ok: true, found: 0, notFound: true, tried: spellings } };
      }
      if (found.length > 1) {
        // Two people match: ask, never pick one silently.
        return { summary: { ok: true, chooseOne: found.map((c) => ({ customerId: c.contactId, name: c.name, channels: c.channels.map((ch) => channelName(ch, ctx.locale)), openConversations: c.openConversations })) } };
      }
      contactId = found[0]!.contactId;
    }
    id = await customersConversation(ctx, contactId);
    if (!id) return { summary: { ok: true, found: 0, note: "this customer has no conversation the user can see" } };
  }
  id = id ?? ctx.selectedConversationId ?? null;
  if (!id) return { summary: { ok: false, error: "say which conversation: a customer's name or id (no conversation is selected)" } };

  const c = await visibleConversation(ctx, id);
  if (!c) return { summary: { ok: false, error: "conversation not found" } };

  const limit = Math.min(50, Math.max(1, Number(args.limit) || 20));
  const tz = await tenantTimeZone(ctx.tenantId);
  const [messages, intel, first] = await Promise.all([
    prisma.message.findMany({
      where: { tenantId: ctx.tenantId, conversationId: c.id, NOT: { messageType: "system" } },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { direction: true, body: true, createdAt: true, senderName: true },
    }),
    prisma.conversationIntelligence.findFirst({ where: { tenantId: ctx.tenantId, conversationId: c.id }, select: { summary: true } }),
    // An imported conversation's row is created after its first message: it started at the earlier one.
    prisma.message.findFirst({ where: { tenantId: ctx.tenantId, conversationId: c.id }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
  ]);
  const started = first?.createdAt && first.createdAt < c.createdAt ? first.createdAt : c.createdAt;
  const summaryParts = intel?.summary ? summaryFields(intel.summary, ctx.locale) : [];
  const ordered = [...messages].reverse();
  const customer = customerDisplayName(c.customerName, c.customerExternalId, ctx.locale);
  const who = c.assignedAgent?.name ?? (!c.isHandedOver && (c.handledBy === "ai_agent" || c.handledBy === "flow") ? "GOTCHA" : c.status === "CLOSED" ? (he ? "ללא שיוך" : "Unassigned") : (he ? "ממתינה לאדם" : "Waiting for a person"));
  const sId = ctx.nextId("s");
  const deepLink = `/inbox?c=${c.id}`;
  const fields = [
    { key: "channel", label: he ? "ערוץ" : "Channel", value: channelName(c.channel, ctx.locale) },
    { key: "state", label: he ? "מצב" : "State", value: STATE[c.status]?.[ctx.locale] ?? c.status },
    { key: "handler", label: he ? "מטפל" : "Who has it", value: who },
    { key: "started", label: he ? "התחילה" : "Started", value: whenText(started, ctx.locale, tz) },
    ...(c.lastMessageAt ? [{ key: "last", label: he ? "הודעה אחרונה" : "Last message", value: whenText(c.lastMessageAt, ctx.locale, tz) }] : []),
    ...summaryParts,
  ];
  const blocks = [{ type: "record" as const, id: ctx.nextId("b"), title: customer, sourceId: sId, kind: "conversation" as const, fields, deepLink, partial: null }];
  const source = {
    id: sId, kind: "conversation" as const, count: null, deepLink,
    label: he ? `השיחה עם ${customer}` : `The conversation with ${customer}`,
    query: { tool: "conversation" as const, params: { conversationId: c.id } },
  };
  return {
    summary: {
      ok: true, cite: sId, conversationId: c.id, customer,
      channel: channelName(c.channel, ctx.locale), state: STATE[c.status]?.[ctx.locale] ?? c.status, whoHasIt: who,
      ...(summaryParts.length ? { summary: Object.fromEntries(summaryParts.map((f) => [f.label, f.value])) } : {}),
      messageCount: ordered.length,
      messages: ordered.map((m) => ({
        when: whenText(m.createdAt, ctx.locale, tz),
        role: m.direction === "INBOUND" ? "customer" : "business",
        by: m.senderName || null,
        // Null, not "": no text (a photo, a voice note) is a fact to say plainly.
        text: m.body ? m.body.slice(0, 600) : null,
      })),
      shownAs: RECORD_SHOWN_AS,
      cards: cardsOf(blocks, ctx.locale),
    },
    blocks,
    source,
  };
}
