import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const api = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => api }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: async () => {} }));

import { askAboutRequest } from './actions';

beforeEach(() => {
  api.post.mockReset();
});

describe('★★ 03’s Ask at the wire (ai 9a86bfac)', () => {
  it('POST /api/assistant/threads with the request as its context - and no message', async () => {
    api.post.mockImplementation(
      async ({ payload }: { payload: { parse: (v: unknown) => unknown } }) =>
        payload.parse({
          id: 'th9',
          title: null,
          scope: { range: 'last_7', channels: 'all' },
          context: { approvalId: 'ap1' },
        }),
    );
    expect(await askAboutRequest('ap1')).toEqual({ ok: true, threadId: 'th9' });
    expect(api.post).toHaveBeenCalledTimes(1);
    const request = api.post.mock.calls[0]![0] as { endpoint: { path: string }; body: unknown };
    expect(request.endpoint.path).toBe('/api/assistant/threads');
    expect(request.body).toEqual({ context: { approvalId: 'ap1' } });
  });

  it('404 APPROVAL_NOT_FOUND - gone, or out of view - is `gone`; anything else `failed`', async () => {
    api.post.mockRejectedValueOnce(
      new ApiError({ kind: 'not_found', status: 404, code: 'APPROVAL_NOT_FOUND' }),
    );
    expect(await askAboutRequest('ap1')).toEqual({ ok: false, reason: 'gone' });
    api.post.mockRejectedValueOnce(new ApiError({ kind: 'server', status: 500 }));
    expect(await askAboutRequest('ap1')).toEqual({ ok: false, reason: 'failed' });
  });
});
