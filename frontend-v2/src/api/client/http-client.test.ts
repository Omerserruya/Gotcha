import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { HttpClient } from './http-client';

const client = new HttpClient({ baseUrl: 'https://api.test', defaultTimeoutMs: 5_000 });
const endpoint = { path: '/api/x', route: '/api/x' };

const capture = () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return () => fetchMock.mock.calls[0] as unknown as [string, RequestInit];
};

afterEach(() => vi.unstubAllGlobals());

describe('★ a body is JSON - unless it is a file', () => {
  it('JSON: stringified, with a JSON content type', async () => {
    const call = capture();
    await client.post({ endpoint, payload: z.unknown(), body: { a: 1 } });
    const [, init] = call();
    expect(init.body).toBe('{"a":1}');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('⚠⚠ FormData: sent as itself, and with NO content type of ours', async () => {
    // A hand-set multipart type has no boundary, and the upload arrives unreadable.
    const call = capture();
    const form = new FormData();
    form.append('file', new File(['x'], 'a.txt'));
    await client.post({ endpoint, payload: z.unknown(), body: form });
    const [, init] = call();
    expect(init.body).toBe(form);
    expect(init.headers as Record<string, string>).not.toHaveProperty('content-type');
  });
});
