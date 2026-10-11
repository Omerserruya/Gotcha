'use server';

import { z } from 'zod';

import { serverApi } from '@/api/client/server-api';
import { approvalsSchema } from '@/api/contracts/approvals';
import { byOrderSchema, looksLikeOrderNumber } from '@/api/contracts/customer-facts';
import {
  collapseToPeople,
  customerListSchema,
  customerRowSchema,
  labelOfPerson,
  reachHandle,
  type CustomerRow,
  type GenericPerson,
} from '@/api/contracts/customers';
import { approvalEndpoints, customerEndpoints, inboxEndpoints } from '@/api/endpoints/registry';
import { quoteOf, type QuoteKind } from '@/api/contracts/message-kind';
import { logger } from '@/observability/logger';
import { signInIfSignedOut } from '@/api/client/signed-out';

/**
 * 19's GO TO, for conversations: `GET /api/conversations?search=` - the one
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
        lastMessageAt: z.string().nullable().catch(null).default(null),
        lastMessageBody: z.string().nullable().catch(null).default(null),
        lastMessageType: z.string().nullable().catch(null).default(null),
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
  /** What tells one person's conversations apart: when, and their last word. */
  readonly lastAt: string | null;
  readonly lastWord: string | null;
  /**
   * The last message's kind when it is not words ("Photo"), as the inbox
   * list says it (`quoteOf`) - never its stored "[Image]".
   */
  readonly lastKind: QuoteKind | null;
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
      hits: page.data.map((row) => {
        const said = quoteOf({
          body: row.lastMessageBody ?? '',
          messageType: row.lastMessageType,
        });
        return {
          id: row.id,
          name: row.customerName,
          handle: row.customerExternalId,
          channel: row.channel,
          lastAt: row.lastMessageAt,
          lastWord:
            said && 'text' in said ? said.text.replace(/\s+/g, ' ').trim().slice(0, 60) : null,
          lastKind: said && 'kind' in said ? said.kind : null,
        };
      }),
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
  /**
   * A nameless customer, said by their channel in the reader's words
   * ("Instagram customer"). Never a raw platform id: `personLabel`'s rule.
   */
  readonly generic: GenericPerson | null;
  readonly handle: string | null;
  /** Found by an order number (`by-order`), not by name/phone/email. */
  readonly byOrder: string | null;
};

/**
 * An order number that found no customer: the store answered, or there was
 * no store to ask. The route answers `contactId: null` alike for "no such
 * order" and "an order no contact matches", so one sentence covers both.
 */
export type OrderMiss =
  | { readonly kind: 'no_match'; readonly number: string; readonly source: string }
  | { readonly kind: 'no_store'; readonly number: string };

export type ActionHit = {
  readonly id: string;
  /** The approval's own sentence - what it would do, to whom. */
  readonly summary: string;
};

/**
 * 19's customers and DO THIS. GO TO: the contacts search (name, phone or
 * email, by the query's shape) and, for an order number, the store's order's
 * customer. DO THIS: only what can actually be acted on - an approval
 * PENDING for one of those people. Nothing is invented from the words: no
 * pending approval, no section.
 */
export async function searchPeople(query: string): Promise<
  | {
      readonly ok: true;
      readonly people: readonly PersonHit[];
      readonly actions: readonly ActionHit[];
      readonly orderMiss?: OrderMiss | null;
    }
  | { readonly ok: false }
> {
  const search = query.trim().slice(0, 80);
  if (search.length < 2) return { ok: true, people: [], actions: [] };
  try {
    const [listed, byOrder] = await Promise.all([
      contactsMatching(search),
      looksLikeOrderNumber(search) ? orderCustomer(search) : Promise.resolve(null),
    ]);
    const ordered = byOrder?.row ?? null;
    const orderMiss = byOrder?.miss ?? null;
    const rows = [...(ordered ? [ordered] : []), ...(listed ?? [])];
    const people = collapseToPeople(rows)
      .slice(0, 5)
      .map(({ primary: row, members }) => ({
        id: row.id,
        ...(() => {
          // The list's own rule (Backend 83579ac8): never an IG or Messenger id.
          const label = labelOfPerson(members);
          return label === null
            ? { name: null, generic: null }
            : 'name' in label
              ? { name: label.name, generic: null }
              : { name: null, generic: label.generic };
        })(),
        handle: reachHandle(row),
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
    return { ok: true, people, actions, orderMiss };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('command.people_failed', { cause });
    return { ok: false };
  }
}

/*
 * The palette's two reads, here rather than borrowed from Customers: the
 * shell may not depend on a feature. Same routes, same rules - one field by
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

async function orderCustomer(
  search: string,
): Promise<{ readonly row: CustomerRow | null; readonly miss: OrderMiss | null } | null> {
  const number = search.replace(/^#/, '');
  try {
    const found = await serverApi().get({
      endpoint: customerEndpoints.byOrder(),
      payload: byOrderSchema,
      query: { number: search },
      raw: true,
    });
    if (found.source === null) return { row: null, miss: { kind: 'no_store', number } };
    if (!found.contactId) {
      return { row: null, miss: { kind: 'no_match', number, source: found.source } };
    }
    const contact = await serverApi().get({
      endpoint: customerEndpoints.detail(found.contactId),
      payload: z.object({ data: customerRowSchema }),
      raw: true,
    });
    return { row: contact.data, miss: null };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('command.by_order_failed', { cause });
    return null;
  }
}
