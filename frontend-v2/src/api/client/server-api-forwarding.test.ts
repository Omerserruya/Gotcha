/*
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

/**
 * ★★ Every server call carries who is asking, so the gateway's rate limit is
 * per person and not one bucket for this server (prod, 2026-11-16: one
 * looping console tab got every merchant's server calls refused).
 */
const incoming = vi.hoisted(() => ({ value: new Headers() as Headers | null }));
const forward = vi.hoisted(() => ({ value: 'on' as 'on' | 'off' }));
vi.mock('server-only', () => ({}));
vi.mock('next-intl/server', () => ({ getLocale: async () => 'he' }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => {
    if (incoming.value === null) throw new Error('outside a request');
    return incoming.value;
  },
}));
vi.mock('@/auth/session-store', () => ({ activeSession: async () => ({ at: 'at', tid: 't' }) }));
vi.mock('@/observability/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/config/env.server', () => ({
  serverEnv: () => ({
    API_BASE_URL: 'http://gateway',
    API_TIMEOUT_MS: 5000,
    API_FORWARD_CLIENT: forward.value,
    APP_ORIGIN: 'https://app.gotcha.co.il',
  }),
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
  return (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
};

afterEach(() => {
  vi.unstubAllGlobals();
  incoming.value = new Headers();
  forward.value = 'on';
});

describe('★★ serverApi says who is asking', () => {
  it('★★ the browser’s address beside the credentials, on the call itself', async () => {
    incoming.value = new Headers({ 'x-real-ip': '203.0.113.9', 'cf-connecting-ip': '198.51.100.1' });
    const sent = await sentHeaders();
    expect(sent['cf-connecting-ip']).toBe('203.0.113.9');
    expect(sent['x-forwarded-proto']).toBe('https');
    expect(sent['x-forwarded-host']).toBe('app.gotcha.co.il');
    expect(sent.authorization).toBe('Bearer at');
  });

  it('★ outside a request: no address, and the call still goes', async () => {
    incoming.value = null;
    const sent = await sentHeaders();
    expect(sent['cf-connecting-ip']).toBeUndefined();
    expect(sent.authorization).toBe('Bearer at');
  });

  it('★ switched off: nothing about the client is sent', async () => {
    forward.value = 'off';
    incoming.value = new Headers({ 'x-real-ip': '203.0.113.9' });
    const sent = await sentHeaders();
    expect(Object.keys(sent).filter((k) => k.startsWith('x-forwarded') || k === 'cf-connecting-ip')).toEqual([]);
  });
});
