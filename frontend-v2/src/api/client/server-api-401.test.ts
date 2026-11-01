/*
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

/** ★★ A 401 on any server read is remembered for the rest of the request. */
const marked = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('./session-rejected', () => ({ markSessionRejected: marked }));
const supportEnded = vi.hoisted(() => vi.fn());
vi.mock('@/support/support-ended', () => ({ markSupportEnded: supportEnded }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('@/auth/session-store', () => ({ activeSession: async () => ({ at: 'at', tid: 't' }) }));
vi.mock('@/config/env.server', () => ({
  serverEnv: () => ({ API_BASE_URL: 'http://api.test', API_TIMEOUT_MS: 5000 }),
}));

const { serverApi } = await import('./server-api');
const { authEndpoints } = await import('@/api/endpoints/registry');

const read = () =>
  serverApi().get({
    endpoint: authEndpoints.me(),
    payload: z.object({ data: z.array(z.unknown()) }),
    raw: true,
  });

beforeEach(() => {
  marked.mockReset();
  supportEnded.mockReset();
});

describe('serverApi and a refused session', () => {
  it('401: marked, and the read still fails as before', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })),
    );
    await expect(read()).rejects.toMatchObject({ status: 401 });
    expect(marked).toHaveBeenCalledTimes(1);
  });

  it('403 is not signed out: not marked', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })),
    );
    await expect(read()).rejects.toMatchObject({ status: 403 });
    expect(marked).not.toHaveBeenCalled();
  });

  it.each(['support_expired', 'support_session_invalid'])(
    '★★ 401 %s ends support mode, not the sign-in',
    async (code) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify({ error: 'x', code }), { status: 401 })),
      );
      await expect(read()).rejects.toMatchObject({ status: 401 });
      expect(supportEnded).toHaveBeenCalledTimes(1);
      expect(marked).not.toHaveBeenCalled();
    },
  );
});
