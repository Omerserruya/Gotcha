/**
 * Private numbers in what the assistant reads (Omer's ruling, 2026-10-08).
 *
 * An InboundExclusion keeps a customer's number out of GOTCHA, on a whole
 * channel or on one of the business's numbers. Ingest enforces it for new
 * messages; rows from before the rule still exist, and the assistant must not
 * surface them either: a contact under a channel-wide rule, and a conversation
 * under any rule, are hidden.
 */
import { prisma, normalizeExclusionValue, withHistoricalRecords } from "@chatcenter/shared";

export interface PrivateNumber { channel: string; channelAccountId: string | null; digits: string }

export async function privateNumbers(tenantId: string): Promise<PrivateNumber[]> {
  const rules = await prisma.inboundExclusion.findMany({ where: { tenantId }, select: { channel: true, channelAccountId: true, customerExternalId: true } });
  return rules.map((r) => ({ channel: String(r.channel), channelAccountId: r.channelAccountId, digits: r.customerExternalId }));
}

/** A contact kept out of GOTCHA on its whole channel. */
export function contactIsPrivate(c: { channel: string; externalId: string }, rules: PrivateNumber[]): boolean {
  const d = normalizeExclusionValue(c.externalId);
  return !!d && rules.some((r) => r.channelAccountId === null && r.channel === c.channel && r.digits === d);
}

/** A conversation kept out of GOTCHA on its channel, or on its number. */
export function conversationIsPrivate(c: { channel: string; customerExternalId: string; channelAccountId: string | null }, rules: PrivateNumber[]): boolean {
  const d = normalizeExclusionValue(c.customerExternalId);
  return !!d && rules.some((r) => r.channel === c.channel && r.digits === d && (r.channelAccountId === null || r.channelAccountId === c.channelAccountId));
}

/**
 * The same rule as a Prisma condition on conversations, so a list is filtered
 * in SQL (filtering after a LIMIT drops rows and breaks the next page).
 * A channel's id may be stored with or without "+".
 */
export function privateConversationsClause(rules: PrivateNumber[]): Record<string, unknown> | null {
  if (!rules.length) return null;
  return {
    NOT: {
      OR: rules.map((r) => ({
        channel: r.channel,
        customerExternalId: { in: [r.digits, `+${r.digits}`] },
        ...(r.channelAccountId ? { channelAccountId: r.channelAccountId } : {}),
      })),
    },
  };
}

/**
 * Which of these conversations are a private number's, live or imported
 * (imported history is excluded only at ingest, so a rule made after an
 * import must still hide what it brought in). Read in SQL, one query.
 */
export async function privateConversationIds(tenantId: string, ids: string[], rules?: PrivateNumber[]): Promise<Set<string>> {
  const r = rules ?? (await privateNumbers(tenantId));
  const clause = privateConversationsClause(r) as { NOT: { OR: unknown[] } } | null;
  if (!clause || !ids.length) return new Set();
  const rows = await withHistoricalRecords(() =>
    prisma.conversation.findMany({ where: { tenantId, id: { in: ids }, OR: clause.NOT.OR as any }, select: { id: true } }),
  );
  return new Set(rows.map((c) => c.id));
}

/** A customer's number under any rule, whatever the channel: for reads that know only the number. */
export function numberIsPrivate(externalId: string | null | undefined, rules: PrivateNumber[]): boolean {
  const d = normalizeExclusionValue(String(externalId ?? ""));
  return !!d && rules.some((r) => r.digits === d);
}
