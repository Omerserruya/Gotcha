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

describe('★★ a message’s file streams through the BFF (the platform serves it only to a logged-in caller)', () => {
  const MEDIA = ['api', 'conversations', 'c1', 'messages', 'm1', 'media', 'f.ogg'];
  const media = { params: Promise.resolve({ path: MEDIA }) };
  const url = `http://app.test/api/bff/${MEDIA.join('/')}`;

  /** The upstream fetch, recording the URL and headers it was sent. */
  const fileUpstream = (answer: () => Response) => {
    const seen: { url?: string; headers?: Headers; signal?: AbortSignal } = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (target: URL, init: RequestInit) => {
        seen.url = String(target);
        seen.headers = new Headers(init.headers);
        seen.signal = init.signal!;
        return answer();
      }),
    );
    return seen;
  };

  it('★★ Range in, 206 out: the part, its Content-Range, and what a player needs to seek', async () => {
    const seen = fileUpstream(
      () =>
        new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 206,
          headers: {
            'content-type': 'audio/ogg',
            'content-length': '4',
            'content-range': 'bytes 0-3/1000',
            'accept-ranges': 'bytes',
            etag: 'W/"3e8-1"',
            'last-modified': 'Sat, 10 Oct 2026 10:00:00 GMT',
            'cache-control': 'private, no-store',
            'content-security-policy': 'sandbox',
            'x-content-type-options': 'nosniff',
          },
        }),
    );
    const response = await GET(new NextRequest(url, { headers: { range: 'bytes=0-3' } }), media);

    expect(seen.url).toBe(`https://api.test/${MEDIA.join('/')}`);
    expect(seen.headers!.get('range')).toBe('bytes=0-3');
    expect(seen.headers!.get('authorization')).toBe('Bearer token');
    expect(response.status).toBe(206);
    expect(response.headers.get('content-type')).toBe('audio/ogg');
    expect(response.headers.get('content-length')).toBe('4');
    expect(response.headers.get('content-range')).toBe('bytes 0-3/1000');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('etag')).toBe('W/"3e8-1"');
    expect(response.headers.get('last-modified')).toBe('Sat, 10 Oct 2026 10:00:00 GMT');
    expect(response.headers.get('content-security-policy')).toBe('sandbox');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3, 4]);
  });

  it('★ a document says it is an attachment, so it downloads rather than renders', async () => {
    fileUpstream(
      () =>
        new Response('%PDF-1.4', {
          headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment' },
        }),
    );
    const response = await GET(new NextRequest(url), media);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe('attachment');
    expect(await response.text()).toBe('%PDF-1.4');
  });

  it('★★ a file still arriving outlives the timeout - a long voice note is never cut mid-file', async () => {
    const seen = fileUpstream(
      () =>
        new Response(new ReadableStream({ start() {} }), {
          headers: { 'content-type': 'video/mp4' },
        }),
    );
    const response = await GET(new NextRequest(url), media);
    // The body is passed on as a stream, not read first: this resolved while it is still open.
    expect(response.body).not.toBeNull();
    await pause(120);
    expect(seen.signal!.aborted).toBe(false);
  });

  it('a JSON answer to a GET keeps its timeout on the body', async () => {
    const seen = fileUpstream(
      () =>
        new Response(new ReadableStream({ start() {} }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    await GET(new NextRequest(url), media);
    await pause(120);
    expect(seen.signal!.aborted).toBe(true);
  });

  it('a conditional GET is passed on, and 304 comes back with no body', async () => {
    const seen = fileUpstream(
      () => new Response(null, { status: 304, headers: { etag: 'W/"3e8-1"' } }),
    );
    const response = await GET(
      new NextRequest(url, { headers: { 'if-none-match': 'W/"3e8-1"' } }),
      media,
    );
    expect(seen.headers!.get('if-none-match')).toBe('W/"3e8-1"');
    expect(response.status).toBe(304);
    expect(response.headers.get('etag')).toBe('W/"3e8-1"');
    expect(response.body).toBeNull();
  });

  it('a compressed answer, decoded by fetch, does not carry the compressed length', async () => {
    fileUpstream(
      () =>
        new Response('a,b\n1,2\n', {
          headers: {
            'content-type': 'text/csv',
            'content-encoding': 'gzip',
            'content-length': '3',
          },
        }),
    );
    const response = await GET(new NextRequest(url), media);
    expect(response.headers.get('content-length')).toBeNull();
    expect(response.headers.get('content-encoding')).toBeNull();
  });

  it('If-Range is passed on, so a resumed read is not stitched from two versions', async () => {
    const seen = fileUpstream(
      () => new Response('x', { headers: { 'content-type': 'video/mp4' } }),
    );
    await GET(
      new NextRequest(url, { headers: { range: 'bytes=10-', 'if-range': 'W/"3e8-1"' } }),
      media,
    );
    expect(seen.headers!.get('range')).toBe('bytes=10-');
    expect(seen.headers!.get('if-range')).toBe('W/"3e8-1"');
  });

  it('a refusal is the platform’s bare 404, passed on as it is', async () => {
    fileUpstream(() => new Response('Not Found', { status: 404 }));
    const response = await GET(new NextRequest(url), media);
    expect(response.status).toBe(404);
  });

  it.each([
    ['none', null],
    ['one that allows caching', 'public, max-age=600'],
    ['one that only says private', 'private'],
  ])('★ an upstream Cache-Control of %s is replaced by no-store', async (_label, given) => {
    fileUpstream(
      () =>
        new Response('x', {
          headers: { 'content-type': 'image/jpeg', ...(given ? { 'cache-control': given } : {}) },
        }),
    );
    const response = await GET(new NextRequest(url), media);
    expect(response.headers.get('cache-control')).toBe('no-store, private');
  });
});
