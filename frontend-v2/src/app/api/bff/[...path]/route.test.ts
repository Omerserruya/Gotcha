import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/client/credential-surface', () => ({ refuseOnCredentialSurface: () => null }));
vi.mock('@/api/client/csrf', () => ({ assertSameOrigin: () => null }));
vi.mock('@/config/env.server', () => ({
  serverEnv: () => ({ API_BASE_URL: 'https://api.test', API_TIMEOUT_MS: 40 }),
}));
vi.mock('@/auth/session-store', () => ({
  activeSession: async () => ({ at: 'token', tid: 't1' }),
}));
vi.mock('@/auth/session', () => ({ sessionCookieOptions: () => ({ name: 'gotcha_session' }) }));
vi.mock('@/observability/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { GET, POST } from './route';

const PATH = ['api', 'assistant', 'threads', 'th1', 'messages'];
const context = { params: Promise.resolve({ path: PATH }) };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The upstream fetch, recording the signal it was given. */
const upstream = (answer: (signal: AbortSignal) => Promise<Response>) => {
  const seen: { signal?: AbortSignal } = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: URL, init: RequestInit) => {
      seen.signal = init.signal!;
      return answer(init.signal!);
    }),
  );
  return seen;
};
const openStream = () =>
  new Response(new ReadableStream({ start() {} }), {
    headers: { 'content-type': 'text/event-stream' },
  });
const never = (signal: AbortSignal) =>
  new Promise<Response>((_resolve, reject) =>
    signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
  );

afterEach(() => vi.unstubAllGlobals());

describe('★★ a stream’s timeout ends when it answers (the BFF cut every answer at 20s)', () => {
  it('★★ an event stream that has begun outlives the timeout', async () => {
    const seen = upstream(async () => openStream());
    const response = await POST(
      new NextRequest(`http://app.test/api/bff/${PATH.join('/')}`, {
        method: 'POST',
        headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
        body: '{"text":"hi"}',
      }),
      context,
    );
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    await pause(120);
    expect(seen.signal!.aborted).toBe(false);
  });

  it('a stream that never begins is still timed out: 502, never a hang', async () => {
    upstream(never);
    const response = await GET(
      new NextRequest(`http://app.test/api/bff/${PATH.join('/')}`, {
        headers: { accept: 'text/event-stream' },
      }),
      context,
    );
    expect(response.status).toBe(502);
  });

  it('an ordinary call keeps its timeout', async () => {
    upstream(never);
    const response = await GET(
      new NextRequest(`http://app.test/api/bff/${PATH.join('/')}`),
      context,
    );
    expect(response.status).toBe(502);
  });

  it('the browser going closes the stream upstream (it does not cancel the run: that has a route)', async () => {
    const seen = upstream(async () => openStream());
    const browser = new AbortController();
    await POST(
      new NextRequest(`http://app.test/api/bff/${PATH.join('/')}`, {
        method: 'POST',
        headers: { accept: 'text/event-stream' },
        body: '{}',
        signal: browser.signal,
      }),
      context,
    );
    expect(seen.signal!.aborted).toBe(false);
    browser.abort();
    expect(seen.signal!.aborted).toBe(true);
  });
});
