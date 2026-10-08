/**
 * A customer's card for the assistant: who they are, how to reach them, their
 * tags, what GOTCHA learned about them, the team's notes, their conversations
 * and (with a store and the right to read it) their orders. What the
 * /customers/<id> screen shows, by the same rules:
 *   - the customer: visibleCustomer (contacts permission, private numbers);
 *   - conversations: the inbox's visibility (the conversation list);
 *   - notes: the conversation service's own notes route with the caller's
 *     token (it hides another person's private notes);
 *   - orders: only with customer:commerce:read, through the store read the
 *     customer's orders tab uses.
 * One source: the customer's conversations (replayable as "show all"); the
 * card and the rows both cite it.
 */
import { getCustomerMemory } from "./customer-memory.service";
import { getCustomerOrders } from "./customer-orders.service";
import { findCustomers, visibleCustomer, type CustomerCtx } from "./assistant-customers.service";
import { queryConversations, normalizeQuery, tenantTimeZone, SHOWN_AS, cardsOf, type ConversationQuery } from "./assistant-query.service";
import { channelName, whenText } from "./system-tools.service";
import { money } from "./assistant-commerce-query.service";

export interface CardCtx extends CustomerCtx {
  canReadCommerce: boolean;
  /** The caller's token, for the services that own the notes. */
  authToken?: string;
}

const CONVERSATION_URL = () => process.env.CONVERSATION_SERVICE_URL || "http://conversation:4002";

interface NoteRow { body: string; authorName: string | null; createdAt: string; visibility: string }

/** The notes the caller may read, from the service that owns them; null when it cannot be asked. */
async function readNotes(contactId: string, authToken?: string): Promise<NoteRow[] | null> {
  if (!authToken) return null;
  try {
    const r = await fetch(`${CONVERSATION_URL()}/api/identity/${encodeURIComponent(contactId)}/notes`, {
      headers: { Authorization: `Bearer ${authToken}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    return Array.isArray(j?.notes) ? j.notes : null;
  } catch {
    return null;
  }
}

const READ_ONLY = { canRead: true, canOpen: false, canCancel: false, canRefund: false, canReturn: false, canTag: false, canNote: false, canNotify: false };

export async function customerCardResult(ctx: CardCtx, args: { customerId?: string; customer?: string[] }): Promise<{ summary: Record<string, unknown>; blocks?: unknown[]; source?: unknown }> {
  const he = ctx.locale === "he";
  let contactId = typeof args.customerId === "string" && args.customerId ? args.customerId : null;
  if (!contactId) {
    const spellings = (args.customer ?? []).map(String).filter(Boolean).slice(0, 4);
    if (!spellings.length) return { summary: { ok: false, error: "say which customer: customerId or their name" } };
    const found = await findCustomers(ctx, spellings);
    if (!found.length) {
      return { summary: spellings.length === 1
        ? { ok: true, found: 0, retry: "search again with the name in the other script (Hebrew or Latin letters) and the first name alone (customer: [...]) before saying the customer was not found" }
        : { ok: true, found: 0, notFound: true, tried: spellings } };
    }
    if (found.length > 1) return { summary: { ok: true, chooseOne: found.map((c) => ({ customerId: c.contactId, name: c.name, channels: c.channels.map((ch) => channelName(ch, ctx.locale)), openConversations: c.openConversations })) } };
    contactId = found[0]!.contactId;
  }

  const customer = await visibleCustomer(ctx, contactId);
  if (!customer) return { summary: { ok: false, error: "customer not found" } };

  // Their conversations: the list (the card's source), on every channel of the person.
  const q = normalizeQuery({ now: true, customerIds: customer.contactIds, list: true }) as ConversationQuery;
  const conversations = await queryConversations(ctx, q);
  const latest = (conversations.summary.rows as Array<{ conversationId: string }> | undefined)?.[0]?.conversationId ?? null;

  const tz = await tenantTimeZone(ctx.tenantId);
  const [notes, memory, orders] = await Promise.all([
    readNotes(customer.contactId, ctx.authToken),
    latest ? getCustomerMemory(ctx.tenantId, latest).catch(() => null) : Promise.resolve(null),
    ctx.canReadCommerce
      ? getCustomerOrders({ tenantId: ctx.tenantId, contactId: customer.contactId, locale: ctx.locale, limit: 5, perms: READ_ONLY }).catch(() => null)
      : Promise.resolve(null),
  ]);

  const facts = (memory?.facts ?? []).slice(0, 5).map((f) => `${f.key}: ${f.value}`);
  const orderRows = orders?.source ? orders.orders.map((o) => ({
    number: o.orderNumber,
    total: money(Number(o.total.amount), o.total.currency, ctx.locale),
    state: [o.financial?.label, o.fulfillment?.label].filter(Boolean).join(" · "),
    when: whenText(new Date(o.createdAt), ctx.locale, tz, false),
  })) : null;

  const source = { ...(conversations.source as any), label: he ? `${customer.name}: השיחות` : `${customer.name}: conversations` };
  const sId = source.id;
  const fields = [
    { key: "channels", label: he ? "ערוצים" : "Channels", value: customer.channels.map((c) => channelName(c, ctx.locale)).join(", ") },
    ...(customer.phone ? [{ key: "phone", label: he ? "טלפון" : "Phone", value: customer.phone }] : []),
    ...(customer.email ? [{ key: "email", label: he ? "אימייל" : "Email", value: customer.email }] : []),
    ...(customer.tags.length ? [{ key: "tags", label: he ? "תגיות" : "Tags", value: customer.tags.join(", ") }] : []),
    { key: "open", label: he ? "שיחות פתוחות" : "Open conversations", value: String(customer.openConversations) },
    ...(customer.lastContactAt ? [{ key: "last", label: he ? "קשר אחרון" : "Last contact", value: whenText(customer.lastContactAt, ctx.locale, tz, false) }] : []),
    ...(facts.length ? [{ key: "learned", label: he ? "מה GOTCHA למדה" : "What GOTCHA learned", value: facts.slice(0, 3).join(" · ") }] : []),
    ...(notes?.length ? [{ key: "notes", label: he ? "הערות" : "Notes", value: he ? `${notes.length} הערות, האחרונה: ${notes[0]!.body.slice(0, 80)}` : `${notes.length} notes, latest: ${notes[0]!.body.slice(0, 80)}` }] : []),
    ...(orderRows?.length ? [{ key: "orders", label: he ? "הזמנות" : "Orders", value: he ? `${orderRows.length} אחרונות, האחרונה ${orderRows[0]!.number} (${orderRows[0]!.total})` : `latest ${orderRows.length}, the last ${orderRows[0]!.number} (${orderRows[0]!.total})` }] : []),
  ];
  const card = { type: "record" as const, id: ctx.nextId("b"), title: customer.name, sourceId: sId, kind: "customer" as const, fields, deepLink: `/customers/${customer.contactId}?tab=everything`, partial: null };
  // The card first, then their conversations (already citing the same source).
  const blocks = [card, ...((conversations.blocks as any[]) ?? [])];

  return {
    summary: {
      ok: true, cite: sId,
      customerId: customer.contactId,
      name: customer.name,
      channels: customer.channels.map((c) => channelName(c, ctx.locale)),
      email: customer.email, phone: customer.phone, tags: customer.tags,
      openConversations: customer.openConversations,
      conversations: customer.conversations,
      lastContact: customer.lastContactAt ? whenText(customer.lastContactAt, ctx.locale, tz) : null,
      learned: facts,
      notes: notes === null ? null : notes.slice(0, 3).map((n) => ({ text: n.body.slice(0, 200), by: n.authorName, when: whenText(new Date(n.createdAt), ctx.locale, tz, false) })),
      ...(ctx.canReadCommerce ? { orders: orderRows } : {}),
      conversationRows: conversations.summary.rows ?? [],
      shownAs: SHOWN_AS,
      cards: cardsOf(blocks, ctx.locale),
    },
    blocks,
    source,
  };
}
