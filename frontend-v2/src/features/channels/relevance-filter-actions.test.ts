import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const patch = vi.hoisted(() =>
  vi.fn(async (_request: unknown): Promise<unknown> => {
    throw new Error('a test must never change a channel for real');
  }),
);
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ patch }) }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: async () => {} }));

import { setRelevanceFilter } from './relevance-filter-actions';

beforeEach(() => {
  patch.mockReset();
  patch.mockImplementation(async () => {
    throw new Error('a test must never change a channel for real');
  });
  revalidatePath.mockClear();
});

describe('★★ a channel account’s relevance filter: PATCH /api/channels/:id/relevance-filter', () => {
  it.each([true, false])('sends {relevanceFilterEnabled: %s}, by the account’s id', async (on) => {
    patch.mockResolvedValueOnce({ data: { id: 'ca1', relevanceFilterEnabled: on } });
    expect(await setRelevanceFilter('ca1', on)).toEqual({ ok: true });
    expect(patch).toHaveBeenCalledTimes(1);
    const call = patch.mock.calls[0]![0] as { endpoint: { path: string }; body: unknown };
    expect(call.endpoint.path).toBe('/api/channels/ca1/relevance-filter');
    expect(call.body).toEqual({ relevanceFilterEnabled: on });
    expect(revalidatePath).toHaveBeenCalledWith('/[locale]/settings/channels', 'page');
  });

  it.each([
    [400, 'RELEVANCE_FILTER_NOT_APPLICABLE', 'not_applicable'],
    [400, 'INVALID_RELEVANCE_FILTER', 'failed'],
    [404, 'CHANNEL_NOT_FOUND', 'not_found'],
    [403, 'FORBIDDEN', 'forbidden'],
    [500, 'RELEVANCE_FILTER_SAVE_FAILED', 'failed'],
  ] as const)('%i %s is "%s": a reason, never the route’s text', async (status, code, reason) => {
    patch.mockRejectedValueOnce(
      new ApiError({ kind: 'server', status, code, developerMessage: 'nope' }),
    );
    expect(await setRelevanceFilter('ca1', true)).toEqual({ ok: false, reason });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('no answer at all is "failed"', async () => {
    patch.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await setRelevanceFilter('ca1', false)).toEqual({ ok: false, reason: 'failed' });
  });

  it('★ a value that is not a boolean is never sent', async () => {
    expect(await setRelevanceFilter('ca1', 'yes' as unknown as boolean)).toEqual({
      ok: false,
      reason: 'failed',
    });
    expect(patch).not.toHaveBeenCalled();
  });
});
