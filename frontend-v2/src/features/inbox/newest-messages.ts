import { z } from 'zod';

import { inboxEndpoints } from '@/api/endpoints/registry';

/**
 * A conversation's NEWEST messages, oldest first, as the stream draws them.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ THE ROUTE PAGES FROM THE OLDEST
 * ════════════════════════════════════════════════════════════════════════════
 * `GET /api/conversations/:id/messages` orders by `createdAt asc` and takes
 * `limit` (default 50, at most 100) from page 1. Read without a page, every
 * conversation past 50 messages stopped at its 50th: a photo sent and read on
 * WhatsApp never appeared, and the thread ended on an old text (Omer, phone,
 * 2026-11-04). Here: page 1 says how many there are, and when there are more
 * than one page holds, the last two pages are read and the newest `PAGE` kept.
 */
export const PAGE = 100;

interface Api {
  get<T extends z.ZodType>(request: {
    readonly endpoint: ReturnType<typeof inboxEndpoints.messages>;
    readonly payload: T;
    readonly raw: true;
    readonly query: Readonly<Record<string, number>>;
  }): Promise<z.infer<T>>;
}

export async function readNewestMessages<M extends z.ZodType>(
  api: Api,
  conversationId: string,
  message: M,
): Promise<z.infer<M>[]> {
  const schema = z.object({
    data: z.array(message),
    meta: z.object({ total: z.number() }).partial().optional(),
  });
  const endpoint = inboxEndpoints.messages(conversationId);
  const read = (page: number) =>
    api.get({ endpoint, payload: schema, raw: true, query: { page, limit: PAGE } });

  const first = await read(1);
  const total = first.meta?.total ?? first.data.length;
  if (total <= PAGE) return first.data;

  const last = Math.ceil(total / PAGE);
  const [before, tail] = await Promise.all([
    last - 1 === 1 ? Promise.resolve(first) : read(last - 1),
    read(last),
  ]);
  return [...before.data, ...tail.data].slice(-PAGE);
}
