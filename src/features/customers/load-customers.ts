import 'server-only';

import { serverApi } from '@/api/client/server-api';
import {
  customerListSchema,
  isTruncated,
  listedCount,
  SEGMENT_PAGE_SIZE,
  type CustomerRow,
} from '@/api/contracts/customers';
import { customerEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

import { withCaptureFixtures } from './capture-fixtures';

/**
 * The customer list.
 *
 * `POST /api/contacts/segment` with no rules — every local contact, with the
 * route's genuine `prisma.contact.count` as the total. **Not** `GET
 * /api/contacts`, which is a CRM proxy search and returns nothing on a tenant
 * without a connected CRM.
 *
 * ── SEARCH ──
 * The vocabulary now has **fourteen** cases including `name`, which landed
 * 2026-09-20 and searches `displayName` with `contains` and
 * `mode: "insensitive"`.
 *
 * Rules are **ANDed** by the route (`where.AND`), so sending name, phone and
 * email together would demand all three match. One field is chosen from the
 * shape of the query instead. **Order number remains unsearchable** — orders
 * are not local to this platform at all — and the screen says so rather than
 * reporting a bare "no results".
 *
 * ── A RULE THE SERVER DOES NOT RECOGNISE IS DROPPED IN SILENCE ──
 * `switch (rule.field)` has no default, so an unknown field is skipped and the
 * query returns **more** rows, not fewer — a failed filter looks exactly like
 * a successful broad match. `SegmentField` below makes that a compile error
 * rather than a silent broadening, which is the only place it can be caught.
 *
 * ── ORDER ──
 * The route hardcodes `orderBy: { lastSeenAt: "desc" }` over a column nothing
 * writes, so rows arrive in whatever order Postgres returns for all-nulls.
 * **That is not an order**, and nothing above this function may present it as
 * one. There is no sort control for the same reason: the server would ignore
 * it.
 */
export interface CustomersData {
  readonly rows: readonly CustomerRow[] | null;
  /** Matching contacts, which may exceed `rows.length` — the route takes 500. */
  readonly total: number;
  /** True when the count exceeds what was returned. */
  readonly truncated: boolean;
  /** Which single field the query was matched against, or null for no query. */
  readonly searchedField: 'name' | 'phone' | 'email' | null;
}

/**
 * The fields `switch (rule.field)` actually handles.
 *
 * A union rather than `string`, because an unrecognised field is silently
 * ignored by the route and widens the result set. This turns that into a
 * compile error.
 */
type SegmentField =
  | 'name'
  | 'phone'
  | 'email'
  | 'channel'
  | 'tag'
  | 'hasTag'
  | 'source'
  | 'inactiveDays'
  | 'lastSeenAfter'
  | 'lastInteractionAfter'
  | 'lastInteractionBefore'
  | 'createdAfter'
  | 'createdBefore'
  | 'optedOut';

/**
 * Which single field a free-text query is matched against.
 *
 * Narrower than `SegmentField` on purpose: only three of the fourteen are
 * reachable from a text box, and the return type says so rather than leaving
 * the caller to handle eleven cases that cannot occur.
 */
export function fieldForQuery(query: string): 'name' | 'phone' | 'email' | null {
  const q = query.trim();
  if (!q) return null;
  if (q.includes('@')) return 'email';
  // Digits and phone punctuation only — anything else is treated as a name,
  // which is the field a person reaches for first.
  if (/^[+\d][\d\s\-()]*$/.test(q)) return 'phone';
  return 'name';
}

function rulesForQuery(query: string): {
  rules: { field: SegmentField; operator: string; value: string }[];
} {
  const field = fieldForQuery(query);
  return field ? { rules: [{ field, operator: 'contains', value: query.trim() }] } : { rules: [] };
}

export async function loadCustomers(query = ''): Promise<CustomersData> {
  const q = query.trim();
  try {
    const result = await serverApi().post({
      endpoint: customerEndpoints.list(),
      payload: customerListSchema,
      body: rulesForQuery(q),
      // `{ data, total }` sit side by side, so unwrapping `data` would throw
      // the count away — and the count is the only honest total on the screen.
      raw: true,
    });

    /*
     * Capture fixtures, applied to what the real read returned — so a failed
     * read stays a failed read. See `capture-fixtures.ts`: gated on
     * `E2E_SECURITY_FIXTURES=1` AND a loopback origin, failing closed.
     */
    const rows = withCaptureFixtures(result.data, q) ?? result.data;

    return {
      rows,
      // Not `result.total` unless the page was actually filled — the route's
      // count includes the merged-away rows its list excludes.
      total: listedCount(rows.length, result.total),
      truncated: isTruncated(rows.length),
      searchedField: fieldForQuery(q),
    };
  } catch (cause) {
    logger.warn('customers.list_failed', { cause });
    return { rows: null, total: 0, truncated: false, searchedField: null };
  }
}

export { SEGMENT_PAGE_SIZE };
