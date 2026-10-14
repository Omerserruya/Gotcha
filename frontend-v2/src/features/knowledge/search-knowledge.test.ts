import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const get = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));

import { searchKnowledge } from './search-knowledge';

// The real client unwraps a top-level `data` unless `raw` is set.
const answer = (body: unknown) =>
  get.mockImplementation(
    async ({ payload, raw }: { payload: { parse: (v: unknown) => unknown }; raw?: boolean }) => {
      const envelope = body as { data?: unknown };
      return payload.parse(!raw && 'data' in envelope ? envelope.data : body);
    },
  );

beforeEach(() => {
  get.mockReset();
});

describe('★★ K1: the knowledge search (GET /api/knowledge-bases/search)', () => {
  it('the hits, read as the route answers them: data beside q and hasMore', async () => {
    answer({
      data: [
        {
          id: 'd1',
          knowledgeBaseId: 'kb1',
          knowledgeBaseName: 'FAQ',
          title: 'Cancelling an order',
          matchIn: 'title',
          snippet: 'You can cancel within 24 hours.',
          updatedAt: '2026-10-10T10:00:00.000Z',
        },
        { title: 'no id' },
      ],
      q: 'cancel',
      hasMore: true,
    });
    const read = await searchKnowledge('  cancel  ');
    expect(get.mock.calls[0]![0].endpoint.path).toBe('/api/knowledge-bases/search');
    expect(get.mock.calls[0]![0].query).toEqual({ q: 'cancel', limit: 20 });
    expect(read).toEqual({
      state: 'ok',
      q: 'cancel',
      hasMore: true,
      hits: [expect.objectContaining({ id: 'd1', matchIn: 'title', knowledgeBaseName: 'FAQ' })],
    });
  });

  it('under 2 or over 200 characters: said, never sent', async () => {
    expect(await searchKnowledge(' a ')).toEqual({ state: 'short', q: 'a' });
    expect((await searchKnowledge('x'.repeat(201))).state).toBe('long');
    expect(get).not.toHaveBeenCalled();
  });

  it("the route's own refusals in words; anything else failed", async () => {
    get.mockRejectedValue(
      new ApiError({ kind: 'validation', status: 400, code: 'QUERY_TOO_SHORT' }),
    );
    expect((await searchKnowledge('ab')).state).toBe('short');
    get.mockRejectedValue(new ApiError({ kind: 'server', status: 500 }));
    expect((await searchKnowledge('ab')).state).toBe('failed');
  });
});
