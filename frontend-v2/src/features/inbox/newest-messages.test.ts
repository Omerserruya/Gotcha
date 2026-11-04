import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';

import { logger } from '@/observability/logger';

import { PAGE, readNewestMessages } from './newest-messages';

const row = z.object({ id: z.number() });

/** The route's own paging: `createdAt asc`, `limit` per page, page 1 first. */
function route(total: number) {
  const all = Array.from({ length: total }, (_, i) => ({ id: i + 1 }));
  return vi.fn(async (request: { payload: z.ZodType; query: { page: number; limit: number } }) => {
    const { page, limit } = request.query;
    return request.payload.parse({
      data: all.slice((page - 1) * limit, page * limit),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  }) as unknown as Parameters<typeof readNewestMessages>[0]['get'] & ReturnType<typeof vi.fn>;
}

describe('readNewestMessages', () => {
  // Omer, 2026-11-04: a 52-message conversation drew its first 50 and never the photo after.
  it('★★ past one page, the newest messages, oldest first, ending on the last', async () => {
    const get = route(152);
    const got = await readNewestMessages({ get }, 'c1', row);
    expect(got).toHaveLength(PAGE);
    expect(got[0]).toEqual({ id: 53 });
    expect(got.at(-1)).toEqual({ id: 152 });
  });

  it('★ 52 messages: all of them, the last included', async () => {
    const got = await readNewestMessages({ get: route(52) }, 'c1', row);
    expect(got).toHaveLength(52);
    expect(got.at(-1)).toEqual({ id: 52 });
  });

  it('just over a page: pages 1 and 2, read once each', async () => {
    const get = route(PAGE + 7);
    const got = await readNewestMessages({ get }, 'c1', row);
    expect(got.at(-1)).toEqual({ id: PAGE + 7 });
    expect(got).toHaveLength(PAGE);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('⚠ no total from the route: the first page, and a warning, never silence', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const get = vi.fn(async () => ({ data: [{ id: 1 }] })) as unknown as Parameters<
      typeof readNewestMessages
    >[0]['get'];
    const got = await readNewestMessages({ get }, 'c1', row);
    expect(got).toEqual([{ id: 1 }]);
    expect(warn).toHaveBeenCalledWith('inbox.messages_total_missing', { conversationId: 'c1' });
    warn.mockRestore();
  });
});
