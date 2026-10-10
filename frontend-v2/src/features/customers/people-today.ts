import { collapseToPeople, type CustomerRow } from '@/api/contracts/customers';
import { pairKey } from '@/api/contracts/identity';
import { quoteOf, type QuoteKind } from '@/api/contracts/message-kind';

/**
 * 04's rows as 02 writes them - "what is true about that person today" -
 * from what the platform holds. The contact itself carries none of it:
 * `lastInteractionAt` is never written. Their CONVERSATIONS do, so each
 * person is joined to their newest one by the identities they write from.
 */

/** One conversation, as much of it as a row needs. */
export interface ConversationFact {
  readonly customerExternalId: string | null;
  readonly status: 'OPEN' | 'WAITING' | 'CLOSED';
  readonly lastMessageAt: string | null;
  readonly lastMessageBody: string | null;
  /** The last message's type (conversation 33e6216a); absent from an older service. */
  readonly lastMessageType?: string | null;
  readonly lastMessageDirection: 'INBOUND' | 'OUTBOUND' | null;
}

export interface PersonToday {
  readonly key: string;
  readonly primary: CustomerRow;
  readonly channels: readonly string[];
  readonly members: readonly CustomerRow[];
  /** Their newest conversation's last message; `null` when none was read. */
  readonly lastContactAt: string | null;
  /** That message, as the row's second line - when it is words. */
  readonly situation: string | null;
  /** …or what kind of message it was ("Photo"), never its stored "[Image]" (`quoteOf`). */
  readonly situationKind: QuoteKind | null;
  /** Open, and a word in the last 24 hours: "talking to you now". */
  readonly talking: boolean;
  /** …and the last word was theirs: they are waiting on you. */
  readonly waiting: boolean;
  /** The platform counts them as gone quiet (`dormant-customers`) - the segment. */
  readonly quiet: boolean;
  /** No word for 90 days: 02 dims the row. A look, not the segment. */
  readonly faded: boolean;
}

export const QUIET_AFTER_DAYS = 90;
const NOW_WINDOW_MS = 24 * 3_600_000;

export type Segment = 'everyone' | 'talking' | 'quiet';
export function segmentOf(raw: string | undefined): Segment {
  return raw === 'talking' || raw === 'quiet' ? raw : 'everyone';
}

export function peopleToday(
  rows: readonly CustomerRow[],
  conversations: readonly ConversationFact[] | null,
  quietIds: ReadonlySet<string> | null,
  now: Date,
): readonly PersonToday[] {
  const newest = new Map<string, ConversationFact>();
  const open = new Set<string>();
  for (const c of conversations ?? []) {
    if (!c.customerExternalId) continue;
    if (c.status !== 'CLOSED') open.add(c.customerExternalId);
    const seen = newest.get(c.customerExternalId);
    if (!seen || (c.lastMessageAt ?? '') > (seen.lastMessageAt ?? '')) {
      newest.set(c.customerExternalId, c);
    }
  }
  const quietBefore = now.getTime() - QUIET_AFTER_DAYS * 86_400_000;

  return collapseToPeople(rows)
    .map((person) => {
      const ids = person.members.map((m) => m.externalId).filter(Boolean);
      const latest = ids
        .map((id) => newest.get(id))
        .filter((c): c is ConversationFact => c !== undefined)
        .sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''))[0];
      const at = latest?.lastMessageAt ?? null;
      const isOpen = ids.some((id) => open.has(id));
      // A month-old open conversation is not "now" (02: 37 of 4,180).
      const talking = isOpen && at !== null && Date.parse(at) >= now.getTime() - NOW_WINDOW_MS;
      const said = latest
        ? quoteOf({ body: latest.lastMessageBody ?? '', messageType: latest.lastMessageType })
        : null;
      return {
        ...person,
        lastContactAt: at,
        situation: said && 'text' in said ? said.text.replace(/\s+/g, ' ').trim() || null : null,
        situationKind: said && 'kind' in said ? said.kind : null,
        talking,
        // Waiting stays on any open conversation whose last word was theirs.
        waiting: isOpen && latest?.lastMessageDirection === 'INBOUND',
        quiet: ids.some((id) => quietIds?.has(id)),
        faded: at !== null && Date.parse(at) < quietBefore,
      };
    })
    .sort((a, b) => (b.lastContactAt ?? '').localeCompare(a.lastContactAt ?? ''));
}

export function inSegment(person: PersonToday, segment: Segment): boolean {
  return segment === 'everyone' || (segment === 'talking' ? person.talking : person.quiet);
}

/** "12m ago", "Yesterday", "2 days", "4 months" - 02's last-contact column. */
export function sinceWords(iso: string, now: Date): { key: string; n?: number } {
  const ms = now.getTime() - Date.parse(iso);
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return { key: 'minutes', n: Math.max(1, minutes) };
  const hours = Math.round(minutes / 60);
  if (hours < 24) return { key: 'hours', n: hours };
  const days = Math.floor(ms / 86_400_000);
  if (days < 2) return { key: 'yesterday' };
  if (days < 31) return { key: 'days', n: days };
  return { key: 'months', n: Math.max(1, Math.round(days / 30)) };
}

/**
 * "Two accounts look like one person" - matched on a shared phone or email,
 * as the design says, between rows the unifier has NOT already joined, and
 * never a pair somebody marked "not the same" (04, `pairKey`). A suggestion
 * only: merging is a person's call.
 */
export function duplicateSuggestion(
  rows: readonly CustomerRow[],
  notSame: ReadonlySet<string> = new Set(),
): readonly [CustomerRow, CustomerRow] | null {
  const seen = new Map<string, CustomerRow>();
  const keyOf = (row: CustomerRow): string[] => [
    ...(row.phone ? [`p:${row.phone.replace(/\D/g, '').slice(-9)}`] : []),
    ...(row.email ? [`e:${row.email.trim().toLowerCase()}`] : []),
  ];
  for (const row of rows) {
    if (row.mergedIntoId) continue;
    for (const key of keyOf(row)) {
      if (key.length < 6) continue;
      const other = seen.get(key);
      const samePerson = other && other.personId !== null && other.personId === row.personId;
      const turnedDown = other && notSame.has(pairKey(other.id, row.id));
      if (other && !samePerson && !turnedDown && other.id !== row.id) return [other, row];
      if (!other) seen.set(key, row);
    }
  }
  return null;
}
