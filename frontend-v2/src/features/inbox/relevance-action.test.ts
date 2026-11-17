import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/**
 * ★ The override's server action. `serverApi` is mocked: no request is made.
 */
const put = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ put }) }));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: async () => {} }));

const actions = async () => import('./conversation-actions');

beforeEach(() => {
  put.mockReset().mockResolvedValue({});
  revalidatePath.mockReset();
});

describe('★★ setConversationRelevance', () => {
  it.each(['business', 'personal'])(
    '★★ PUTs `{ category: %s }` to the relevance route',
    async (category) => {
      const { setConversationRelevance } = await actions();
      await expect(setConversationRelevance('c1', category)).resolves.toEqual({ ok: true });
      expect(put).toHaveBeenCalledWith(
        expect.objectContaining({
          body: { category },
          endpoint: expect.objectContaining({
            path: expect.stringMatching(/\/api\/conversations\/c1\/relevance$/),
          }),
        }),
      );
      expect(revalidatePath).toHaveBeenCalled();
    },
  );

  it('★★ anything else the browser sends is refused before any request', async () => {
    const { setConversationRelevance } = await actions();
    for (const category of ['notice', 'marketing', 'unclear', '', 'BUSINESS']) {
      await expect(setConversationRelevance('c1', category)).resolves.toEqual({
        ok: false,
        reason: 'failed',
      });
    }
    expect(put).not.toHaveBeenCalled();
  });

  it.each([
    [403, 'not_allowed'],
    [404, 'not_found'],
    [500, 'failed'],
  ])('★ %i is %s, and nothing is re-read', async (status, reason) => {
    put.mockRejectedValue(new ApiError({ kind: 'server', status }));
    const { setConversationRelevance } = await actions();
    await expect(setConversationRelevance('c1', 'business')).resolves.toEqual({
      ok: false,
      reason,
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
