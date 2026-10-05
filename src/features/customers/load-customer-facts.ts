import 'server-only';

import { z } from 'zod';

import { serverApi } from '@/api/client/server-api';
import {
  byOrderSchema,
  commerceSegmentsSchema,
  commerceSummariesSchema,
  FACTS_BATCH,
  insightsSchema,
  looksLikeOrderNumber,
  type CommerceSegments,
  type CommerceSummary,
  type Insight,
} from '@/api/contracts/customer-facts';
import { customerRowSchema, type CustomerRow } from '@/api/contracts/customers';
import { customerEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * What the commerce read said about a set of contacts.
 *  - `read`: the store was read; `byId` holds whoever it answered for.
 *  - `none`: there was nothing to read (no store, unreachable, not wired
 *    yet) — a reason, never zeros.
 *  - `null` (the whole value): the read itself failed.
 */
export type CommerceFacts =
  | {
      readonly state: 'read';
      readonly byId: ReadonlyMap<string, CommerceSummary>;
      /** The store's orders were capped: a count can be short, a zero can be wrong. */
      readonly truncated: boolean;
    }
  | { readonly state: 'none'; readonly reason: string | null };

function batches(ids: readonly string[]): string[][] {
  const unique = [...new Set(ids)];
  const out: string[][] = [];
  for (let i = 0; i < unique.length; i += FACTS_BATCH) out.push(unique.slice(i, i + FACTS_BATCH));
  return out;
}

export async function loadCommerce(ids: readonly string[]): Promise<CommerceFacts | null> {
  if (ids.length === 0) return { state: 'read', byId: new Map(), truncated: false };
  try {
    const pages = await Promise.all(
      batches(ids).map((chunk) =>
        serverApi().get({
          endpoint: customerEndpoints.commerceSummary(),
          payload: commerceSummariesSchema,
          query: { contactIds: chunk.join(',') },
          // `data` sits beside `source`: unwrapped, the source would be lost.
          raw: true,
        }),
      ),
    );
    const none = pages.find((page) => page.source === null);
    if (none) return { state: 'none', reason: none.reason };
    const byId = new Map<string, CommerceSummary>();
    for (const page of pages) {
      for (const [id, summary] of Object.entries(page.data)) if (summary) byId.set(id, summary);
    }
    return { state: 'read', byId, truncated: pages.some((page) => page.truncated) };
  } catch (cause) {
    logger.warn('customers.commerce_failed', { cause });
    return null;
  }
}

/** Each contact's open conversation, as the row says it; `null` when unread. */
export async function loadInsights(
  ids: readonly string[],
): Promise<ReadonlyMap<string, Insight | null> | null> {
  if (ids.length === 0) return new Map();
  try {
    const pages = await Promise.all(
      batches(ids).map((chunk) =>
        serverApi().get({
          endpoint: customerEndpoints.insights(),
          payload: insightsSchema,
          query: { ids: chunk.join(',') },
          raw: true,
        }),
      ),
    );
    return new Map(pages.flatMap((page) => Object.entries(page.data)));
  } catch (cause) {
    logger.warn('customers.insights_failed', { cause });
    return null;
  }
}

/** "Who your customers are"; `null` when the read failed. */
export async function loadSegments(): Promise<CommerceSegments | null> {
  try {
    return await serverApi().get({
      endpoint: customerEndpoints.commerceSegments(),
      payload: commerceSegmentsSchema,
      raw: true,
    });
  } catch (cause) {
    logger.warn('customers.segments_failed', { cause });
    return null;
  }
}

const detailSchema = z.object({ data: customerRowSchema });

/**
 * The customer an order number belongs to, as a list row — or `null`: not an
 * order number, no such order, nobody matched, or the read failed. Only ever
 * ADDED to a search; it never replaces the name/phone/email match.
 */
export async function customerByOrder(query: string): Promise<CustomerRow | null> {
  if (!looksLikeOrderNumber(query)) return null;
  try {
    const found = await serverApi().get({
      endpoint: customerEndpoints.byOrder(),
      payload: byOrderSchema,
      query: { number: query.trim() },
      raw: true,
    });
    if (!found.contactId) return null;
    const contact = await serverApi().get({
      endpoint: customerEndpoints.detail(found.contactId),
      payload: detailSchema,
      raw: true,
    });
    return contact.data;
  } catch (cause) {
    logger.warn('customers.by_order_failed', { cause });
    return null;
  }
}
