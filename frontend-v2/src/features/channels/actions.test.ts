import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const get = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));

import { startChannelConnect } from './actions';

beforeEach(() => {
  get.mockReset();
});

describe('★★ init-url at the wire', () => {
  it('the redesign flow, the platform’s own name', async () => {
    get.mockResolvedValue({ url: 'https://www.facebook.com/dialog/oauth?x' });
    expect(await startChannelConnect('INSTAGRAM')).toEqual({
      ok: true,
      url: 'https://www.facebook.com/dialog/oauth?x',
    });
    expect((get.mock.calls[0]![0] as { endpoint: { path: string } }).endpoint.path).toBe(
      '/api/channels/oauth/init-url?platform=instagram&flow=redesign_studio',
    );
  });

  it('a channel with no OAuth: nothing asked', async () => {
    expect(await startChannelConnect('WEBCHAT')).toEqual({ ok: false, reason: 'failed' });
    expect(get).not.toHaveBeenCalled();
  });

  it('http is not followed; 409 is not configured; 403 an admin’s', async () => {
    get.mockResolvedValue({ url: 'http://accounts.google.com' });
    expect(await startChannelConnect('GMAIL')).toEqual({ ok: false, reason: 'failed' });
    for (const [status, reason] of [
      [409, 'not_configured'],
      [403, 'forbidden'],
      [500, 'failed'],
    ] as const) {
      get.mockImplementation(async () => {
        throw new ApiError({ kind: status === 403 ? 'authorization' : 'server', status });
      });
      expect(await startChannelConnect('SLACK')).toEqual({ ok: false, reason });
    }
  });
});
