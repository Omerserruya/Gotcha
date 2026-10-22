import { prisma } from "@chatcenter/shared";

/**
 * Unread, for ONE viewer: the read side of ConversationReadState (7b69c714
 * wrote it; nothing read it until 2026-10-11).
 *
 * A conversation is unread for this person when they marked it unread, or a
 * customer message arrived after they last opened it, or they never opened it
 * and the customer has written. `unreadCount` is the customer messages since
 * that point (WhatsApp's badge), capped at 99; a conversation marked by hand
 * with nothing new is unread with a count of 0 (frontend-v2's contract).
 *
 * Only LIVE, INBOUND, non-system rows count. INBOUND messageType "system" rows
 * are the inbox's own events (a handoff, an automation note), not the customer
 * writing; the list's last-message projection reads LIVE rows, and an imported
 * history is not news.
 */
export const UNREAD_COUNT_CAP = 99;

export interface UnreadState {
  unread: boolean;
  unreadCount: number;
  lastReadAt: string | null;
}

type Row = { id: string; marked_unread: boolean | null; last_read_at: Date | null; new_inbound: bigint | number | null };

/** One query for any number of conversations: no N+1 on a page or a count. */
export async function unreadStates(
  tenantId: string,
  userId: string,
  conversationIds: string[],
  // A transaction client may be passed (the live check runs inside one it rolls back).
  db: { $queryRaw: typeof prisma.$queryRaw } = prisma,
): Promise<Map<string, UnreadState>> {
  const out = new Map<string, UnreadState>();
  if (conversationIds.length === 0) return out;
  const rows = await db.$queryRaw<Row[]>`
    SELECT c.id,
           rs.marked_unread,
           rs.last_read_at,
           (SELECT count(*) FROM messages m
             WHERE m.tenant_id = ${tenantId}
               AND m.conversation_id = c.id
               AND m.direction = 'INBOUND'
               AND m.message_type <> 'system'
               AND m.origin = 'LIVE'
               AND (rs.last_read_at IS NULL OR m.created_at > rs.last_read_at)) AS new_inbound
      FROM unnest(${conversationIds}::text[]) AS c(id)
      LEFT JOIN conversation_read_states rs
        ON rs.conversation_id = c.id AND rs.user_id = ${userId} AND rs.tenant_id = ${tenantId}`;
  for (const r of rows) {
    const fresh = Number(r.new_inbound ?? 0);
    const marked = r.marked_unread === true;
    out.set(r.id, {
      unread: marked || fresh > 0,
      unreadCount: Math.min(fresh, UNREAD_COUNT_CAP),
      lastReadAt: r.last_read_at ? new Date(r.last_read_at).toISOString() : null,
    });
  }
  return out;
}
