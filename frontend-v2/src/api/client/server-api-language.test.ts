/*
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

/**
 * ★★ Every server call carries the interface language. Routes that answer in
 * words choose their language by it - /he/analytics read its topic names in
 * English while this header was missing (Backend 3343c75f).
 */
const locale = vi.hoisted(() => ({ get: vi.fn(async () => 'he') }));
vi.mock('server-only', () => ({}));
vi.mock('next-intl/server', () => ({ getLocale: () => locale.get() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('@/auth/session-store', () => ({ activeSession: async () => ({ at: 'at', tid: 't' }) }));
vi.mock('@/config/env.server', () => ({
  serverEnv: () => ({ API_BASE_URL: 'http://api.test', API_TIMEOUT_MS: 5000 }),
}));

const { serverApi } = await import('./server-api');
const { authEndpoints } = await import('@/api/endpoints/registry');

const sentHeaders = async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  await serverApi().get({
    endpoint: authEndpoints.me(),
    payload: z.object({ data: z.array(z.unknown()) }),
    raw: true,
  });
  return (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<
    string,
    string
  >;
};

afterEach(() => vi.unstubAllGlobals());

describe('★★ the interface language goes with every server call', () => {
  it('Accept-Language is the request’s locale, beside the credentials', async () => {
    const headers = await sentHeaders();
    expect(headers['accept-language']).toBe('he');
    expect(headers.authorization).toBe('Bearer at');
  });

  it('no locale to read (outside a request): no header - and the call is not failed for it', async () => {
    locale.get.mockRejectedValueOnce(new Error('not in a request'));
    const headers = await sentHeaders();
    expect(headers).not.toHaveProperty('accept-language');
    expect(headers.authorization).toBe('Bearer at');
  });
});
