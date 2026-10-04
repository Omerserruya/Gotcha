'use server';

import { z } from 'zod';

import { serverApi } from '@/api/client/server-api';
import { inboxEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';
import { signInIfSignedOut } from '@/api/client/signed-out';

/**
 * 19's GO TO, for conversations: `GET /api/conversations?search=` — the one
 * search the platform has. It matches the customer's name or their channel
 * id (`conversation.service.ts`), across every conversation the viewer may
 * read, automated ones included. Nothing else is searchable: customers,
 * orders, approvals, campaigns and employees have no search.
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
