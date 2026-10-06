'use server';

import { z } from 'zod';

import { serverApi } from '@/api/client/server-api';
import { approvalsSchema } from '@/api/contracts/approvals';
import { byOrderSchema, looksLikeOrderNumber } from '@/api/contracts/customer-facts';
import {
  collapseToPeople,
  customerListSchema,
  customerLabel,
  customerRowSchema,
  type CustomerRow,
} from '@/api/contracts/customers';
import { approvalEndpoints, customerEndpoints, inboxEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';
import { signInIfSignedOut } from '@/api/client/signed-out';

/**
 * 19's GO TO, for conversations: `GET /api/conversations?search=` — the one
 * search the platform has. It matches the customer's name or their channel
 * id (`conversation.service.ts`), across every conversation the viewer may
 * read, automated ones included. Customers and orders are `searchPeople`'s.
 */
const resultSchema = z.object({
  data: z
    .array(
      z.object({
        id: z.string(),
        customerName: z.string().nullable().catch(null).default(null),
        customerExternalId: z.string().nullable().catch(null).default(null),
        channel: z.string().nullable().catch(null).default(null),
      }),
    )
    .catch([])
    .default([]),
});

export type ConversationHit = {
  readonly id: string;
  readonly name: string | null;
  readonly handle: string | null;
  readonly channel: string | null;
};

export async function searchConversations(
  query: string,
): Promise<
  { readonly ok: true; readonly hits: readonly ConversationHit[] } | { readonly ok: false }
> {
  const search = query.trim();
  if (search.length < 2) return { ok: true, hits: [] };
  try {
    const page = await serverApi().get({
      endpoint: inboxEndpoints.list(),
      query: { search: search.slice(0, 80), limit: '5', includeAutomated: 'true' },
      payload: resultSchema,
      raw: true,
    });
    return {
      ok: true,
      hits: page.data.map((row) => ({
        id: row.id,
        name: row.customerName,
        handle: row.customerExternalId,
        channel: row.channel,
      })),
    };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('command.search_failed', { cause });
    return { ok: false };
  }
}

export type PersonHit = {
  readonly id: string;
  readonly name: string | null;
  readonly handle: string | null;
  /** Found by an order number (`by-order`), not by name/phone/email. */
  readonly byOrder: string | null;
};

export type ActionHit = {
  readonly id: string;
  /** The approval's own sentence — what it would do, to whom. */
  readonly summary: string;
};

/**
 * 19's customers and DO THIS. GO TO: the contacts search (name, phone or
 * email, by the query's shape) and, for an order number, the store's order's
 * customer. DO THIS: only what can actually be acted on — an approval
 * PENDING for one of those people. Nothing is invented from the words: no
 * pending approval, no section.
 */
export async function searchPeople(query: string): Promise<
  | {
      readonly ok: true;
      readonly people: readonly PersonHit[];
      readonly actions: readonly ActionHit[];
    }
  | { readonly ok: false }
> {
  const search = query.trim().slice(0, 80);
  if (search.length < 2) return { ok: true, people: [], actions: [] };
  try {
    const [listed, ordered] = await Promise.all([
      contactsMatching(search),
      looksLikeOrderNumber(search) ? orderCustomer(search) : Promise.resolve(null),
    ]);
    const rows = [...(ordered ? [ordered] : []), ...(listed ?? [])];
    const people = collapseToPeople(rows)
      .slice(0, 5)
      .map(({ primary: row, members }) => ({
        id: row.id,
        name: customerLabel(row),
        handle: row.phone ?? row.email ?? (row.externalId || null),
        byOrder: ordered && members.some((r) => r.id === ordered.id) ? search : null,
      }));
    const ids = new Set(rows.map((row) => row.id));
    const pending =
      ids.size === 0
        ? []
        : await serverApi()
            .get({ endpoint: approvalEndpoints.list('PENDING'), payload: approvalsSchema })
            .catch((cause: unknown) => {
              logger.warn('command.approvals_failed', { cause });
              return [];
            });
    const actions = pending
      .filter((a) => a.contactId !== null && ids.has(a.contactId))
      .slice(0, 3)
      .map((a) => ({ id: a.id, summary: a.summary }));
    if (listed === null && !ordered) return { ok: false };
    return { ok: true, people, actions };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('command.people_failed', { cause });
    return { ok: false };
  }
}

/*
 * The palette's two reads, here rather than borrowed from Customers: the
 * shell may not depend on a feature. Same routes, same rules — one field by
 * the query's shape (an "@" is an email; digits and phone punctuation, a
 * phone; else a name), and an order number's customer as a list row.
 */
async function contactsMatching(search: string): Promise<readonly CustomerRow[] | null> {
  const field = search.includes('@')
    ? 'email'
    : /^[+\d][\d\s\-()]*$/.test(search)
      ? 'phone'
      : 'name';
  return serverApi()
    .post({
      endpoint: customerEndpoints.list(),
      payload: customerListSchema,
      body: { rules: [{ field, operator: 'contains', value: search }] },
      raw: true,
    })
    .then((page) => page.data)
    .catch((cause: unknown) => {
      logger.warn('command.customers_failed', { cause });
      return null;
    });
}

async function orderCustomer(search: string): Promise<CustomerRow | null> {
  try {
    const found = await serverApi().get({
      endpoint: customerEndpoints.byOrder(),
      payload: byOrderSchema,
      query: { number: search },
      raw: true,
    });
    if (!found.contactId) return null;
    const contact = await serverApi().get({
      endpoint: customerEndpoints.detail(found.contactId),
      payload: z.object({ data: customerRowSchema }),
      raw: true,
    });
    return contact.data;
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('command.by_order_failed', { cause });
    return null;
  }
}
