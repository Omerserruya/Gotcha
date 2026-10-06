import { beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ post }) }));
vi.mock('next-intl/server', () => ({ getLocale: async () => 'he' }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: async () => undefined }));
vi.mock('../load-copilot', () => ({ loadCopilot: async () => ({ state: 'unavailable' }) }));
vi.mock('server-only', () => ({}));

import { ApiError } from '@/api/client/api-error';

import { refreshSuggestions } from './wall-actions';

beforeEach(() => {
  post.mockReset();
});

describe('★★ refreshSuggestions — "Try again", the one model call here', () => {
  it('posts to the refresh route with the reader’s language', async () => {
    post.mockResolvedValue({ data: [], copilotMode: 'READY_MESSAGE' });
    expect(await refreshSuggestions('c1')).toMatchObject({ state: 'ok' });
    const sent = post.mock.calls[0]![0] as { endpoint: { path: string }; body: unknown };
    expect(sent.endpoint.path).toBe('/api/ai-assist/c1/suggestions/refresh');
    expect(sent.body).toEqual({ locale: 'he' });
  });

  it('★★ 429 REFRESH_RATE_LIMITED is a wait with its seconds — not a failure', async () => {
    post.mockRejectedValue(
      new ApiError({
        kind: 'rate_limited',
        status: 429,
        code: 'REFRESH_RATE_LIMITED',
        retryAfterSeconds: 12,
      }),
    );
    expect(await refreshSuggestions('c1')).toEqual({
      state: 'rate_limited',
      retryAfterSeconds: 12,
    });
  });

  it('a 429 that names no wait is still a wait', async () => {
    post.mockRejectedValue(new ApiError({ kind: 'rate_limited', status: 429 }));
    expect(await refreshSuggestions('c1')).toEqual({
      state: 'rate_limited',
      retryAfterSeconds: null,
    });
  });

  it('anything else is "unavailable"', async () => {
    post.mockRejectedValue(new ApiError({ kind: 'server', status: 500 }));
    expect(await refreshSuggestions('c1')).toEqual({ state: 'unavailable' });
  });
});
