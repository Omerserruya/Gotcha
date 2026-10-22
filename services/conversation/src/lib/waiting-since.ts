import { prisma } from "@chatcenter/shared";

/**
 * Since when the customer has been waiting for a reply (2026-10-12), for the
 * inbox's SLA dot: the FIRST customer message after the last reply, or null
 * when nothing came in after it.
 *
 * Timing from the last customer message instead under-reports: a customer who
 * writes three times restarts the clock each time.
 *
 * - A reply is any OUTBOUND row that did not FAIL (pending counts: the agent
 *   answered; a failed send was never seen), the same rule as the list's
 *   lastMessageDirection. System rows are the inbox's own events, not replies.
 * - A customer message is LIVE, INBOUND and not a system row, the same rule as
 *   unread: an imported history is not someone waiting.
 */
type Row = { id: string; waiting_since: Date | null };

/** One query for the page: no N+1. */
export async function waitingSinceFor(
  tenantId: string,
  conversationIds: string[],
  db: { $queryRaw: typeof prisma.$queryRaw } = prisma,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (conversationIds.length === 0) return out;
  const rows = await db.$queryRaw<Row[]>`
    SELECT c.id,
           (SELECT min(m.created_at) FROM messages m
             WHERE m.tenant_id = ${tenantId}
               AND m.conversation_id = c.id
               AND m.direction = 'INBOUND'
               AND m.message_type <> 'system'
               AND m.origin = 'LIVE'
               AND m.created_at > COALESCE(
                 (SELECT max(o.created_at) FROM messages o
                   WHERE o.tenant_id = ${tenantId}
                     AND o.conversation_id = c.id
                     AND o.direction = 'OUTBOUND'
                     AND o.message_type <> 'system'
                     AND o.status <> 'FAILED'),
                 '-infinity'::timestamp)) AS waiting_since
      FROM unnest(${conversationIds}::text[]) AS c(id)`;
  for (const r of rows) out.set(r.id, r.waiting_since ? new Date(r.waiting_since).toISOString() : null);
  return out;
}
