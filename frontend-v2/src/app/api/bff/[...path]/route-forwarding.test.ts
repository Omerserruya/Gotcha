import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * ★★ The BFF carries every browser API call to the platform. Who is asking is
 * this server's to say, never the browser's: inside the network the gateway
 * trusts CF-Connecting-IP, so a value the browser sent and this route relayed
 * would choose its own rate-limit bucket (prod, 2026-11-16).
 */
const forward = vi.hoisted(() => ({ value: 'on' as 'on' | 'off' }));
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/credential-surface', () => ({ refuseOnCredentialSurface: () => null }));
vi.mock('@/api/client/csrf', () => ({ assertSameOrigin: () => null }));
vi.mock('@/config/env.server', () => ({
  serverEnv: () => ({
    API_BASE_URL: 'http://gateway',
    API_TIMEOUT_MS: 5000,
    API_FORWARD_CLIENT: forward.value,
    APP_ORIGIN: 'https://app.gotcha.co.il',
  }),
}));
vi.mock('@/auth/session-store', () => ({ activeSession: async () => ({ at: 'token', tid: 't1' }) }));
vi.mock('@/auth/session', () => ({ sessionCookieOptions: () => ({ name: 'gotcha_session' }) }));
vi.mock('@/support/support-cookie', () => ({ SUPPORT_COOKIE: 'sup', readSupport: async () => null }));
vi.mock('@/observability/logger', () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

import { GET } from './route';

const PATH = ['api', 'conversations'];
const context = { params: Promise.resolve({ path: PATH }) };

const sent = async (headers: Record<string, string>) => {
  const fetch = vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch);
  await GET(new NextRequest(`http://app.test/api/bff/${PATH.join('/')}`, { headers }), context);
  return (fetch.mock.calls[0] as unknown as [URL, RequestInit])[1].headers as Headers;
};

const BROWSER = {
  'x-real-ip': '203.0.113.9',
  'cf-connecting-ip': '198.51.100.1',
  'x-forwarded-for': '198.51.100.2',
  'x-forwarded-host': 'evil.test',
  'x-forwarded-proto': 'http',
  forwarded: 'for=198.51.100.3',
  accept: 'application/json',
};

afterEach(() => {
  vi.unstubAllGlobals();
  forward.value = 'on';
});

describe('★★ the BFF says who is asking; the browser does not', () => {
  it('★★ on: CF-Connecting-IP is the gateway’s X-Real-IP, never the browser’s own', async () => {
    const headers = await sent(BROWSER);
    expect(headers.get('cf-connecting-ip')).toBe('203.0.113.9');
    expect(headers.get('x-forwarded-host')).toBe('app.gotcha.co.il');
    expect(headers.get('x-forwarded-proto')).toBe('https');
    expect(headers.get('x-forwarded-for')).toBeNull();
    expect(headers.get('forwarded')).toBeNull();
    expect(headers.get('x-real-ip')).toBeNull();
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('authorization')).toBe('Bearer token');
  });

  it('★★ off: the browser’s forwarding headers are still never relayed', async () => {
    forward.value = 'off';
    const headers = await sent(BROWSER);
    for (const name of ['cf-connecting-ip', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip']) {
      expect(headers.get(name)).toBeNull();
    }
    expect(headers.get('accept')).toBe('application/json');
  });
});
