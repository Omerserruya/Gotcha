/**
 * One thread across the website chat and WhatsApp (2026-11-22).
 *
 * A visitor who continues a website chat on WhatsApp is one customer in one
 * conversation: the WhatsApp one. The website chat's messages are shown inside
 * it, in time order, and the website chat itself leaves the inbox list.
 *
 * Nothing is moved. The incoming worker (whatsapp-handoff-link.service.ts)
 * writes two system rows in one transaction, each pointing at the other:
 *   - in the WhatsApp conversation: `continued_from_website` + fromConversationId
 *   - in the website chat:          `continued_on_whatsapp`  + toConversationId
 * and closes and archives the website chat. Everything here is read from those
 * rows, so a row keeps its own conversation, its media route, its quoted
 * message and its place in every count that was made before the link.
 *
 * A link counts only when BOTH rows exist and name each other, and the pointed
 * conversation is a website chat of the same organization. A single stray row
 * therefore cannot pull another conversation's messages into a thread.
 */
import { prisma } from "@chatcenter/shared";

export const CONTINUED_FROM_WEBSITE = "continued_from_website";
export const CONTINUED_ON_WHATSAPP = "continued_on_whatsapp";

/** A thread shows at most this many website chats, the most recent ones. */
export const MAX_LINKED_WEB_CHATS = 5;

/** Where a conversation continued from: the inbox's badge and the thread's merge. */
export interface ContinuedFrom {
  channel: "WEBCHAT";
  conversationId: string;
  /** When the customer arrived on WhatsApp (the divider's time), ISO. */
  at: string;
}

type Db = Pick<typeof prisma, "message">;

const systemEvent = (name: string) => ({ messageType: "system", metadata: { path: ["systemEvent"], equals: name } });

const text = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/**
 * The website chats each of these conversations continued from, most recent
 * first. Conversations with none are absent from the map. Two reads, both on
 * the (conversation, time) index; the second only when the first found a link.
 */
export async function continuedFromFor(tenantId: string, conversationIds: string[], db: Db = prisma): Promise<Map<string, ContinuedFrom[]>> {
  const out = new Map<string, ContinuedFrom[]>();
  if (!conversationIds.length) return out;
  const arrivals = await db.message.findMany({
    where: { tenantId, conversationId: { in: conversationIds }, ...systemEvent(CONTINUED_FROM_WEBSITE) },
    orderBy: { createdAt: "desc" },
    select: { conversationId: true, metadata: true, createdAt: true },
  });
  const claimed: Array<{ to: string; from: string; at: Date }> = [];
  for (const row of arrivals) {
    // The WhatsApp kind of widget writes this event with no website chat.
    const from = text((row.metadata as any)?.fromConversationId);
    if (from && row.conversationId && from !== row.conversationId) claimed.push({ to: row.conversationId, from, at: row.createdAt });
  }
  if (!claimed.length) return out;

  const departures = await db.message.findMany({
    where: {
      tenantId,
      conversationId: { in: [...new Set(claimed.map((c) => c.from))] },
      ...systemEvent(CONTINUED_ON_WHATSAPP),
      conversation: { tenantId, channel: "WEBCHAT" as any },
    },
    select: { conversationId: true, metadata: true },
  });
  const confirmed = new Set<string>();
  for (const row of departures) {
    const to = text((row.metadata as any)?.toConversationId);
    if (to) confirmed.add(`${row.conversationId}>${to}`);
  }

  for (const c of claimed) {
    if (!confirmed.has(`${c.from}>${c.to}`)) continue;
    const list = out.get(c.to) ?? [];
    // The same website chat linked twice counts once, at its latest arrival.
    if (list.some((l) => l.conversationId === c.from) || list.length >= MAX_LINKED_WEB_CHATS) continue;
    list.push({ channel: "WEBCHAT", conversationId: c.from, at: c.at.toISOString() });
    out.set(c.to, list);
  }
  return out;
}

/**
 * A website chat that now lives inside its WhatsApp conversation: closed,
 * archived and carrying the link's own row. The inbox list leaves these out
 * (`NOT` this). Every part is a yes or a no, never NULL, so the NOT drops
 * nothing else. A website chat that is opened again is no longer CLOSED and
 * shows again; one from before 2026-11-22 was never archived and stays listed.
 */
export function mergedAwayWhere(): Record<string, unknown> {
  return {
    channel: "WEBCHAT",
    status: "CLOSED",
    archivedAt: { not: null },
    messages: { some: systemEvent(CONTINUED_ON_WHATSAPP) },
  };
}
