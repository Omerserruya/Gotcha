import { z } from 'zod';

/**
 * Customers — screen 04.
 *
 * Shapes read from `services/conversation/src/routes/contacts.ts`.
 *
 * ── THE LIST IS NOT `GET /api/contacts` ──
 * That route is a **CRM proxy search**, and its own comment says so: *"CRM is
 * the source of truth for people-data. The platform's local Contact table is a
 * write-side cache… it is not surfaced through this endpoint anymore. When no
 * CRM is connected the endpoint returns an empty list."* It needs a connected
 * CRM **and** a non-empty query, and its `meta.total` is `rows.length` — the
 * count of what was returned — so pagination is impossible by construction
 * rather than merely unimplemented.
 *
 * The list this screen uses is `POST /api/contacts/segment`, which queries the
 * **local** `Contact` table and answers a genuine `prisma.contact.count`.
 *
 * ── WHAT A ROW IS, AND WHAT IT IS NOT ──
 * **A row is a channel identity, not a person.** `Contact` carries `personId`
 * — *"multiple contact rows sharing the same personId represent one real human
 * across WA/IG/Gmail/Messenger"* — and `mergedIntoId`, a soft-merge pointer
 * whose row is deliberately **kept** so webhook lookups still resolve.
 *
 * **The segment endpoint returns neither**, and its `where` does not filter
 * merged rows. So one person on two channels is two rows, and after a merge
 * the survivor *and* the tombstone both appear. Nothing here can collapse or
 * hide them, which is why this screen never claims one row is one person.
 * Requested as a one-line addition to that `select`.
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
 * A value outside the set renders **as itself** rather than being dropped —
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
 * `optOutChannels`, `personId` and `mergedIntoId` — none of which a list needs
 * and the first of which is arbitrary tenant-supplied JSON.
 *
 * **`channel` is not enumerated.** It is a real Prisma enum, but a value this
 * app has no word for must still render — dropping a row because we cannot
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
});

export type CustomerRow = z.infer<typeof customerRowSchema>;

/**
 * `POST /contacts/segment` → `{ data, total }` at the top level.
 *
 * `total` is a real `prisma.contact.count` over the same `where`, so it is the
 * number of matching contacts rather than the number returned — unlike
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
 * True when the list is shorter than the count, so the screen must not
 * describe what is on it as everything.
 */
export function isTruncated(shown: number, total: number): boolean {
  return total > shown;
}

/**
 * `GET /contacts/:id` → `{ data: { ...contact, historyByChannel } }`.
 *
 * `historyByChannel` is a genuine `groupBy` over conversations for this
 * contact's `externalId` — a real, cheap version of *"every channel in one
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
