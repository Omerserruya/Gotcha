import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const post = vi.hoisted(() =>
  vi.fn(async (_request: unknown): Promise<unknown> => {
    throw new Error('a test must never disconnect a channel for real');
  }),
);
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ post }) }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: async () => {} }));

import { disconnectChannel } from './disconnect-actions';

beforeEach(() => {
  post.mockReset();
  post.mockImplementation(async () => {
    throw new Error('a test must never disconnect a channel for real');
  });
});

describe('★ a channel row’s Disconnect: POST /api/channels/:id/disconnect', () => {
  it('posts to the route, by the channel account’s id', async () => {
    post.mockResolvedValueOnce({ success: true });
    expect(await disconnectChannel('ca1')).toEqual({ ok: true });
    expect(post).toHaveBeenCalledTimes(1);
    const call = post.mock.calls[0]![0] as { endpoint: { path: string } };
    expect(call.endpoint.path).toBe('/api/channels/ca1/disconnect');
  });

  it.each([
    [404, 'not_found'],
    [403, 'forbidden'],
    [500, 'failed'],
  ] as const)('%i is "%s" - a reason, never the route’s text', async (status, reason) => {
    post.mockRejectedValueOnce(
      new ApiError({ kind: 'server', status, developerMessage: 'Channel not found' }),
    );
    expect(await disconnectChannel('ca1')).toEqual({ ok: false, reason });
  });

  it('no answer at all is "failed"', async () => {
    post.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await disconnectChannel('ca1')).toEqual({ ok: false, reason: 'failed' });
  });
});
