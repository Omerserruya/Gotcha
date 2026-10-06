/**
 * The contact behind a conversation - read-only, batched.
 *
 * `Conversation` carries no contactId, only `(channel, customerExternalId)`.
 * The one existing route from a handle to a contact (`POST /api/identity/resolve`)
 * CREATES a contact on a miss, which made "which customer is this?" a write.
 * This answers it from the unique `(tenantId, channel, externalId)` and never
 * creates anything: no contact is `null`.
 *
 * A merged contact resolves to the contact it was merged INTO (following
 * `mergedIntoId`, a bounded number of hops), because the merged-away row is a
 * tombstone - its notes, tags and history live on the target.
 *
 * Cost: ONE contacts query for a whole page. Only when that page contains
 * merged contacts is there one more query per merge hop, for those targets.
 */
import { prisma } from "@chatcenter/shared";

const MAX_MERGE_HOPS = 5;

export interface ConversationHandle {
  channel: unknown;
  customerExternalId: string | null;
}

const keyOf = (channel: unknown, externalId: string) => `${String(channel)}\u0000${externalId}`;

export async function contactIdsFor(
  tenantId: string,
  rows: ConversationHandle[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const pairs = new Map<string, { channel: any; externalId: string }>();
  for (const r of rows) {
    if (!r.customerExternalId) continue;
    pairs.set(keyOf(r.channel, r.customerExternalId), { channel: r.channel as any, externalId: r.customerExternalId });
  }
  if (pairs.size === 0) return out;

  const contacts = await prisma.contact.findMany({
    where: { tenantId, OR: [...pairs.values()].map((p) => ({ channel: p.channel, externalId: p.externalId })) },
    select: { id: true, channel: true, externalId: true, mergedIntoId: true },
  });

  // Follow merges in batches: every pending pointer in one query per hop.
  const mergedInto = new Map<string, string | null>(); // id -> next pointer (null = live)
  for (const c of contacts) mergedInto.set(c.id, c.mergedIntoId ?? null);
  let pending = [...new Set(contacts.map((c) => c.mergedIntoId).filter((x): x is string => !!x && !mergedInto.has(x)))];
  for (let hop = 0; hop < MAX_MERGE_HOPS && pending.length > 0; hop++) {
    const targets = await prisma.contact.findMany({
      where: { tenantId, id: { in: pending } },
      select: { id: true, mergedIntoId: true },
    });
    // A pointer to a row outside this tenant (or gone) stays absent from the
    // map, and resolve() answers null for it rather than guessing.
    for (const t of targets) mergedInto.set(t.id, t.mergedIntoId ?? null);
    pending = [...new Set(targets.map((t) => t.mergedIntoId).filter((x): x is string => !!x && !mergedInto.has(x)))];
  }

  const resolve = (id: string): string | null => {
    let cur = id;
    for (let i = 0; i <= MAX_MERGE_HOPS; i++) {
      if (!mergedInto.has(cur)) return null;
      const next = mergedInto.get(cur);
      if (!next) return cur;
      cur = next;
    }
    return null; // a cycle or a chain longer than we follow: unknown, not a guess
  };

  for (const c of contacts) out.set(keyOf(c.channel, c.externalId), resolve(c.id));
  return out;
}

/** The contactId for one conversation row from a map built by contactIdsFor. */
export function contactIdOf(map: Map<string, string | null>, row: ConversationHandle): string | null {
  if (!row.customerExternalId) return null;
  return map.get(keyOf(row.channel, row.customerExternalId)) ?? null;
}
