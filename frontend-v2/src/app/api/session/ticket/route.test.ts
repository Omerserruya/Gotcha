import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpClient } from '@/api/client/http-client';

/**
 * The ticket the socket opens with, through the real HTTP client: only the
 * network is stubbed, so the client's unwrap of `data` is the one in use.
 * A mocked `serverApi` would have skipped exactly the step that failed.
 */
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/csrf', () => ({ assertSameOrigin: () => null }));
vi.mock('@/api/client/credential-surface', () => ({ refuseOnCredentialSurface: () => null }));
vi.mock('@/api/client/server-api', () => ({
  serverApi: () => new HttpClient({ baseUrl: 'https://api.test', defaultTimeoutMs: 5_000 }),
}));

const { POST } = await import('./route');

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const answer = (status: number, body: unknown) =>
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
const ask = () =>
  POST(new NextRequest('https://dev.gotcha.co.il/api/session/ticket', { method: 'POST' }));

describe('★★ the platform’s exact answer is a ticket (2026-10-11)', () => {
  it('`{ data: { ticket, expiresInSeconds } }`: 200 with the ticket, never cached', async () => {
    // services/auth/src/routes/realtime.ts: res.json({ data: { ticket, expiresInSeconds } })
    answer(200, { data: { ticket: 'tk_live_1', expiresInSeconds: 60 } });
    const response = await ask();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ticket: 'tk_live_1', expiresInSeconds: 60 });
    expect(response.headers.get('cache-control')).toBe('no-store, private');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('https://api.test/api/realtime/ticket');
    expect(init.method).toBe('POST');
  });

  it('the platform refusing (503): 502, and no ticket', async () => {
    answer(503, { error: 'Realtime tickets are temporarily unavailable' });
    const response = await ask();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'ticket_unavailable' });
  });
});
