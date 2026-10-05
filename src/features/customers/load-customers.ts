import 'server-only';

import { serverApi } from '@/api/client/server-api';
import {
  customerListSchema,
  isTruncated,
  listedCount,
  SEGMENT_PAGE_SIZE,
  type CustomerRow,
} from '@/api/contracts/customers';
import { z } from 'zod';

import { looksLikeOrderNumber } from '@/api/contracts/customer-facts';

import { analyticsEndpoints, customerEndpoints, inboxEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

import { withCaptureFixtures } from './capture-fixtures';
import { customerByOrder } from './load-customer-facts';
import type { ConversationFact } from './people-today';

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
  /** The query looked like an order number, so the store's orders were asked too (04). */
  readonly orderSearched: boolean;
  /**
   * The newest conversations, every status — what makes a row "today": its
   * last word, whether it is open, who spoke last. `null` when unread.
   * The newest 100: a person whose last word is older than those is drawn
   * without one, never as someone who never wrote.
   */
  readonly conversations: readonly ConversationFact[] | null;
  /** Who went quiet (`dormant-customers`): their identities and how many. `null` when unread. */
  readonly quiet: {
    readonly ids: ReadonlySet<string>;
    readonly count: number;
    readonly capped: boolean;
  } | null;
}

const CONVERSATIONS_READ = 100;
const DORMANT_CAP = 100;

const conversationsSchema = z.object({
  data: z
    .array(
      z.object({
        customerExternalId: z.string().nullable().catch(null).default(null),
        status: z.enum(['OPEN', 'WAITING', 'CLOSED']).catch('CLOSED'),
        lastMessageAt: z.string().nullable().catch(null).default(null),
        lastMessageBody: z.string().nullable().catch(null).default(null),
        lastMessageDirection: z.enum(['INBOUND', 'OUTBOUND']).nullable().catch(null).default(null),
      }),
    )
    .default([]),
});

const dormantSchema = z.object({
  data: z.array(z.object({ customerId: z.string().nullable().catch(null) })).default([]),
});

async function readToday(): Promise<Pick<CustomersData, 'conversations' | 'quiet'>> {
  const api = serverApi();
  const [conversations, dormant] = await Promise.all([
    api
      .get({
        endpoint: inboxEndpoints.list(),
        payload: conversationsSchema,
        raw: true,
        query: { limit: CONVERSATIONS_READ, cursor: '' },
      })
      .then((page) => page.data)
      .catch((cause: unknown) => {
        logger.warn('customers.conversations_failed', { cause });
        return null;
      }),
    api
      .get({ endpoint: analyticsEndpoints.dormantCustomers(), payload: dormantSchema, raw: true })
      .catch((cause: unknown) => {
        logger.warn('customers.dormant_failed', { cause });
        return null;
      }),
  ]);
  return {
    conversations,
    quiet:
      dormant === null
        ? null
        : {
            ids: new Set(dormant.data.map((d) => d.customerId).filter((id): id is string => !!id)),
            count: dormant.data.length,
            capped: dormant.data.length >= DORMANT_CAP,
          },
  };
}

/**
 * The fields `switch (rule.field)` actually handles.
 *
 * A union rather than `string`, because an unrecognised field is silently
 * ignored by the route and widens the result set. This turns that into a
 * compile error.
 */
/** Who went quiet (`dormant-customers`), counted — for 05d's "call a list". `null` when unread. */
export async function loadQuiet(): Promise<{
  readonly count: number;
  readonly capped: boolean;
} | null> {
  return serverApi()
    .get({ endpoint: analyticsEndpoints.dormantCustomers(), payload: dormantSchema, raw: true })
    .then((dormant) => ({
      count: dormant.data.length,
      capped: dormant.data.length >= DORMANT_CAP,
    }))
    .catch((cause: unknown) => {
      logger.warn('customers.dormant_failed', { cause });
      return null;
    });
}

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

export async function loadCustomers(
  query = '',
  /** 04 reads the day too; the dialer's search does not need it. */
  { today: withToday = false }: { readonly today?: boolean } = {},
): Promise<CustomersData> {
  const q = query.trim();
  const today = withToday
    ? readToday()
    : Promise.resolve({ conversations: null, quiet: null } as Pick<
        CustomersData,
        'conversations' | 'quiet'
      >);
  // 04's search: an order number finds its customer too — added, never instead.
  const byOrder = withToday ? customerByOrder(q) : Promise.resolve(null);
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
    const listed = withCaptureFixtures(result.data, q) ?? result.data;
    const ordered = await byOrder;
    const rows =
      ordered && !listed.some((row) => row.id === ordered.id) ? [ordered, ...listed] : listed;

    return {
      rows,
      // Not `result.total` unless the page was actually filled — the route's
      // count includes the merged-away rows its list excludes.
      total: listedCount(rows.length, result.total),
      truncated: isTruncated(rows.length),
      searchedField: fieldForQuery(q),
      orderSearched: withToday && looksLikeOrderNumber(q),
      ...(await today),
    };
  } catch (cause) {
    logger.warn('customers.list_failed', { cause });
    return {
      rows: null,
      total: 0,
      truncated: false,
      searchedField: null,
      orderSearched: false,
      ...(await today),
    };
  }
}

export { SEGMENT_PAGE_SIZE };
