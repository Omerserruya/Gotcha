import { z } from 'zod';

/**
 * Customers - screen 04.
 *
 * Shapes read from `services/conversation/src/routes/contacts.ts`.
 *
 * ── THE LIST IS NOT `GET /api/contacts` ──
 * That route is a **CRM proxy search**, and its own comment says so: *"CRM is
 * the source of truth for people-data. The platform's local Contact table is a
 * write-side cache… it is not surfaced through this endpoint anymore. When no
 * CRM is connected the endpoint returns an empty list."* It needs a connected
 * CRM **and** a non-empty query, and its `meta.total` is `rows.length` - the
 * count of what was returned - so pagination is impossible by construction
 * rather than merely unimplemented.
 *
 * The list this screen uses is `POST /api/contacts/segment`, which queries the
 * **local** `Contact` table and answers a genuine `prisma.contact.count`.
 *
 * ── WHAT A ROW IS, AND WHAT IT IS NOT ──
 * **A row is a channel identity, not a person.** `Contact` carries `personId`
 * - *"multiple contact rows sharing the same personId represent one real human
 * across WA/IG/Gmail/Messenger"* - and `mergedIntoId`, a soft-merge pointer
 * whose row is deliberately **kept** so webhook lookups still resolve.
 *
 * **Both are now returned** (requested, and landed 2026-09-20), and the route
 * filters tombstones itself with `where: { ...where, mergedIntoId: null }`.
 * So the design's first line is finally backed: `personId` is what lets one
 * human on WhatsApp and Instagram collapse to one row instead of two.
 *
 * ── BUT THE COUNT AND THE LIST NOW DISAGREE ──
 * The tombstone filter was added to `findMany` and **not** to the `count`
 * above it:
 * ```
 * const count = await prisma.contact.count({ where });                  // tombstones INCLUDED
 * findMany({ where: { ...where, mergedIntoId: null }, take: 500, … })   // tombstones EXCLUDED
 * ```
 * So on any tenant that has ever merged, `total` exceeds `data.length` with
 * nothing truncated - and a screen that trusted `total` would report
 * *"Showing 2 of 3"* with no third customer to show. `listedCount` below is
 * why this screen does not.
 */

/** `ChannelType`. Rendered as a mark on the row, never as a section. */
export const CONTACT_CHANNELS = [
  'WHATSAPP',
  'INSTAGRAM',
  'MESSENGER',
  'EMAIL',
  'WEBCHAT',
  'VOICE',
  'SMS',
  'TELEGRAM',
] as const;

/**
 * True for a channel this app has words for.
 *
 * A value outside the set renders **as itself** rather than being dropped -
 * same call as `riskTags` on approvals: hiding a row because we cannot
 * translate its channel would hide a customer, and that is the wrong failure
 * on this screen.
 */
export function isKnownChannel(channel: string): boolean {
  return (CONTACT_CHANNELS as readonly string[]).includes(channel);
}

/**
 * One row of the customer list.
 *
 * `object`, not `looseObject`. The detail route spreads the whole Prisma row
 * (`{ ...contact, historyByChannel }`), which carries `metadata`,
 * `optOutChannels`, `personId` and `mergedIntoId` - none of which a list needs
 * and the first of which is arbitrary tenant-supplied JSON.
 *
 * **`channel` is not enumerated.** It is a real Prisma enum, but a value this
 * app has no word for must still render - dropping a row because we cannot
 * translate its channel would hide a customer, which is the wrong failure on
 * this screen. Same call as `riskTags` on approvals, for the same reason.
 */
export const customerRowSchema = z.object({
  id: z.string().min(1),
  /** Phone, email or platform id. The channel-native handle. */
  externalId: z.string().default(''),
  displayName: z.string().nullable().default(null),
  channel: z.string().default(''),
  phone: z.string().nullable().default(null),
  email: z.string().nullable().default(null),
  tags: z.array(z.string()).default([]),
  /**
   * **Effectively always null.** Nothing initialises it: the only write on
   * `Contact` is inside `POST /identity/merge`, which carries forward
   * `max(existing, existing)` and therefore yields null from two nulls.
   */
  lastInteractionAt: z.string().nullable().default(null),
  source: z.string().nullable().default(null),
  /**
   * Shared across a person's channel identities. `null` when the unifier has
   * never found a shared identifier, in which case this row is its own person.
   */
  personId: z.string().nullable().default(null),
  /** Always `null` in a list response - the route filters tombstones out. */
  mergedIntoId: z.string().nullable().default(null),
  /**
   * What to call the row (Backend 83579ac8, `lib/contact-label.ts`): the name,
   * phone or email, else words for the channel ("Instagram customer"), never
   * an Instagram or Messenger id. Sent by `POST /contacts/segment` only, so
   * optional: the detail route and an older service send none, and then
   * `personLabel` works it out without ever falling to an opaque id.
   */
  displayLabel: z.string().nullish().catch(undefined),
});

export type CustomerRow = z.infer<typeof customerRowSchema>;

/**
 * `POST /contacts/segment` → `{ data, total }` at the top level.
 *
 * `total` is a real `prisma.contact.count` over the same `where`, so it is the
 * number of matching contacts rather than the number returned - unlike
 * `GET /contacts`. It can legitimately exceed `data.length`, because the route
 * takes 500 and counts everything.
 */
export const customerListSchema = z.object({
  data: z.array(customerRowSchema).default([]),
  total: z.number().default(0),
});

/** The route's own page size. Rows beyond it are counted but not returned. */
export const SEGMENT_PAGE_SIZE = 500;

/**
 * Truncated only when the page was actually filled.
 *
 * **Not `total > shown`.** The route's `count` includes merged-away rows that
 * its `findMany` excludes, so on a tenant that has ever merged the total
 * exceeds the list with nothing truncated at all. Anchoring on the page size
 * asks the question that is actually being asked - *did we hit the limit?* -
 * and is immune to the discrepancy.
 */
export function isTruncated(shown: number): boolean {
  return shown >= SEGMENT_PAGE_SIZE;
}

/**
 * The number this screen is willing to stand behind.
 *
 * When the page was not filled, the rows ARE the answer and their length is
 * exact. The server's `total` is only used when the list is genuinely
 * truncated, where it is the best available figure even though it may include
 * tombstones - and in that case the screen says "of about", not "of".
 */
export function listedCount(shown: number, total: number): number {
  return isTruncated(shown) ? total : shown;
}

/**
 * Channel identities collapsed into people.
 *
 * `personId` is the platform's own cross-channel identity. A row without one
 * is its own person - the unifier assigns it only when a shared identifier is
 * discovered, so its absence means "not known to be the same human", never
 * "the same as the others".
 *
 * The first row of each group wins for display, which is the one the route's
 * ordering put first. Every row is kept on `channels` so the person's reach is
 * visible without a second query.
 */
export function collapseToPeople(rows: readonly CustomerRow[]): readonly {
  readonly key: string;
  readonly primary: CustomerRow;
  readonly channels: readonly string[];
  /** Every identity of the person - each one's conversations are theirs. */
  readonly members: readonly CustomerRow[];
}[] {
  const groups = new Map<string, CustomerRow[]>();
  for (const row of rows) {
    const key = row.personId ?? `row:${row.id}`;
    const existing = groups.get(key);
    if (existing) existing.push(row);
    else groups.set(key, [row]);
  }
  return [...groups.entries()].map(([key, members]) => ({
    key,
    primary: members[0]!,
    channels: [...new Set(members.map((m) => m.channel).filter(Boolean))],
    members,
  }));
}

/**
 * `GET /contacts/:id` → `{ data: { ...contact, historyByChannel } }`.
 *
 * `historyByChannel` is a genuine `groupBy` over conversations for this
 * contact's `externalId` - a real, cheap version of *"every channel in one
 * thread"*, and the only part of 04c that costs nothing.
 */
export const customerDetailSchema = customerRowSchema.extend({
  avatarUrl: z.string().nullable().default(null),
  createdAt: z.string().nullable().default(null),
  historyByChannel: z.record(z.string(), z.number()).default({}),
});

export type CustomerDetail = z.infer<typeof customerDetailSchema>;

/**
 * What to call someone when `displayName` is null.
 *
 * Falls back to a real handle rather than to "Unknown": on a channel like
 * WhatsApp the phone number **is** how the business knows them, and inventing
 * a placeholder would be less informative than the identifier we hold. Returns
 * null only when there is genuinely nothing, and the caller says so.
 */
export function customerLabel(row: {
  displayName: string | null;
  phone: string | null;
  email: string | null;
  externalId: string;
}): string | null {
  return (
    row.displayName?.trim() ||
    row.phone?.trim() ||
    row.email?.trim() ||
    row.externalId.trim() ||
    null
  );
}

/**
 * Channels whose `externalId` IS the customer's phone or address, proven by
 * the channel itself - the same lists as Backend's `PHONE_CHANNELS` and
 * `EMAIL_CHANNELS` (`packages/shared/src/lib/identity-links.ts`). Anywhere
 * else the id is opaque (an IGSID, a PSID, a Slack user, a web session) and
 * means nothing to a person.
 */
const READABLE_ID_CHANNELS: ReadonlySet<string> = new Set([
  'WHATSAPP',
  'VOICE',
  'EMAIL',
  'GMAIL',
  'OUTLOOK',
]);

/**
 * The words Backend's `contactLabel` falls back to, by channel - English
 * strings, so the screen says them in its own words instead.
 */
const GENERIC_BY_CHANNEL = {
  INSTAGRAM: 'Instagram customer',
  MESSENGER: 'Messenger customer',
  WEBCHAT: 'Website visitor',
  SHOPIFY_LIVE_CHAT: 'Store chat visitor',
} as const;
const GENERIC_LAST_RESORT = 'Customer';

/** A nameless contact, said by its channel; `other` is Backend's "Customer". */
export type GenericPerson = keyof typeof GENERIC_BY_CHANNEL | 'other';

/** A name to show as written, or a nameless contact to say in our words. */
export type PersonLabel = { readonly name: string } | { readonly generic: GenericPerson };

type GenericChannel = keyof typeof GENERIC_BY_CHANNEL;
function genericFor(channel: string | null | undefined): GenericChannel | null {
  return channel && Object.hasOwn(GENERIC_BY_CHANNEL, channel) ? (channel as GenericChannel) : null;
}

/**
 * Backend's label read back: one of its fallback words becomes ours, any
 * other string is a name. Only where a fallback was the label: a contact
 * with a stored name, phone or email never reached that branch.
 */
export function labelFromServer(label: string, channel: string | null | undefined): PersonLabel {
  const own = genericFor(channel);
  if (own && label === GENERIC_BY_CHANNEL[own]) return { generic: own };
  if (label === GENERIC_LAST_RESORT) return { generic: 'other' };
  return { name: label };
}

/**
 * What the customer list calls a row: the server's `displayLabel`, and for an
 * older service that sends none, the same rule worked out here. **Never a raw
 * external id**: an id is shown only on a channel where it is the phone or
 * the address, and a label that is just an opaque id (a channel Backend has
 * no words for) is no name at all. `null` when there is nothing to call
 * them; the caller says so in words.
 */
export function personLabel(row: {
  readonly displayLabel?: string | null;
  readonly displayName: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly externalId: string;
  readonly channel: string;
}): PersonLabel | null {
  const stored = row.displayName?.trim() || row.phone?.trim() || row.email?.trim();
  const opaqueId = !READABLE_ID_CHANNELS.has(row.channel) ? row.externalId.trim() : '';
  const sent = row.displayLabel?.trim();
  if (sent) {
    if (opaqueId && sent === opaqueId) return null;
    return stored ? { name: sent } : labelFromServer(sent, row.channel);
  }
  if (stored) return { name: stored };
  const generic = genericFor(row.channel);
  if (generic) return { generic };
  return opaqueId ? null : row.externalId.trim() ? { name: row.externalId.trim() } : null;
}

/**
 * How to reach them, for the row's title: the phone or the address - an id
 * only where it is one of those. Never an opaque platform id.
 */
export function reachHandle(row: {
  readonly phone: string | null;
  readonly email: string | null;
  readonly externalId: string;
  readonly channel: string;
}): string | null {
  return (
    row.phone?.trim() ||
    row.email?.trim() ||
    (READABLE_ID_CHANNELS.has(row.channel) ? row.externalId.trim() : '') ||
    null
  );
}

/**
 * A person's label across their identities: the first one with a name, so a
 * WhatsApp name wins over the Instagram row's "Instagram customer" whichever
 * the route listed first; else the first generic one.
 */
export function labelOfPerson(
  members: readonly Parameters<typeof personLabel>[0][],
): PersonLabel | null {
  const labels = members.map(personLabel);
  return (
    labels.find((l): l is { name: string } => l !== null && 'name' in l) ??
    labels.find((l) => l !== null) ??
    null
  );
}
