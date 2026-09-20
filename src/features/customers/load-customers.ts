import 'server-only';

import { serverApi } from '@/api/client/server-api';
import { customerListSchema, SEGMENT_PAGE_SIZE, type CustomerRow } from '@/api/contracts/customers';
import { customerEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * The customer list.
 *
 * `POST /api/contacts/segment` with no rules — every local contact, with the
 * route's genuine `prisma.contact.count` as the total. **Not** `GET
 * /api/contacts`, which is a CRM proxy search and returns nothing on a tenant
 * without a connected CRM.
 *
 * ── SEARCH ──
 * The rule vocabulary has thirteen cases and **no name case**, so a query is
 * matched against `phone` and `email` only. `name` is requested and this
 * function is written so that adding it is one line — but until it lands, a
 * search for "Dana" finds nothing and the screen has to say which fields it
 * actually looked at rather than reporting "no results".
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
  /** Which fields the query was actually matched against. */
  readonly searchedFields: readonly string[];
}

/** Rules the segment endpoint understands for a free-text query. */
function rulesForQuery(query: string): {
  rules: { field: string; operator: string; value: string }[];
} {
  const q = query.trim();
  if (!q) return { rules: [] };

  // `phone` and `email` are the only text fields the vocabulary can match.
  // A `name` case is requested; when it exists it joins this list.
  return {
    rules: /@/.test(q)
      ? [{ field: 'email', operator: 'contains', value: q }]
      : [{ field: 'phone', operator: 'contains', value: q }],
  };
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

    return {
      rows: result.data,
      total: result.total,
      truncated: result.total > result.data.length,
      searchedFields: q ? (/@/.test(q) ? ['email'] : ['phone']) : [],
    };
  } catch (cause) {
    logger.warn('customers.list_failed', { cause });
    return { rows: null, total: 0, truncated: false, searchedFields: [] };
  }
}

export { SEGMENT_PAGE_SIZE };
