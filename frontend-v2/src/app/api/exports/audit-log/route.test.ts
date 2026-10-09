import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const headers = vi.hoisted(() => vi.fn());
const get = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('next-intl/server', () => ({ getTranslations: vi.fn(), getLocale: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({
  platformHeaders: headers,
  serverApi: () => ({ get }),
}));
vi.mock('@/config/env.server', () => ({ serverEnv: () => ({ API_BASE_URL: 'http://api.test' }) }));

import { GET } from './route';

const request = (q = '?locale=en') => new NextRequest(`http://app.test/api/exports/audit-log${q}`);
/** The platform's file, in chunks that split a line in the middle. */
const upstream = (chunks: string[], status = 200) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
        c.close();
      },
    }),
    { status },
  );
const fetchMock = vi.fn();

beforeEach(() => {
  headers.mockReset();
  get.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('★★ /api/exports/audit-log - the platform’s file, readable, as it streams', () => {
  it('reads the platform’s export with the session, and writes our header then each row', async () => {
    headers.mockResolvedValue({ authorization: 'Bearer t', 'x-tenant-id': 'ten1' });
    get.mockResolvedValue([{ id: 'u1', name: 'Maya Cohen' }]);
    fetchMock.mockResolvedValue(
      upstream([
        '\uFEFFtimestamp,action,actor_type,actor_id,target_type,target_id,succeeded\n"2026-10-08T09:00:00.000Z","ai.respo',
        'nded","ai",,"conversation","c1",\n"2026-10-08T09:01:00.000Z","message.sent","user","u1",,,\n',
      ]),
    );
    const res = await GET(request());
    expect(fetchMock.mock.calls[0]![0].toString()).toBe('http://api.test/api/audit-logs/export');
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ headers: { authorization: 'Bearer t' } });
    expect(res.headers.get('content-type')).toMatch(/text\/csv/);
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="audit-log-/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    // The BOM, so a spreadsheet reads Hebrew as UTF-8.
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = new TextDecoder().decode(bytes).split('\n').filter(Boolean);
    expect(lines[0]!.startsWith('"When","What happened"')).toBe(true);
    // The line split across two chunks arrives whole; the platform's header is not repeated.
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('"GOTCHA"');
    expect(lines[1]).toContain('"ai.responded"');
    expect(lines[2]).toContain('"Maya Cohen"');
  });

  it('no session: 401, and the platform is never asked', async () => {
    headers.mockResolvedValue({ 'accept-language': 'en' });
    const res = await GET(request());
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a refusal upstream is passed on as its status - never as a file', async () => {
    headers.mockResolvedValue({ authorization: 'Bearer t' });
    fetchMock.mockResolvedValue(new Response('{"error":"Forbidden"}', { status: 403 }));
    const res = await GET(request());
    expect(res.status).toBe(403);
    expect(res.headers.get('content-disposition')).toBeNull();
  });

  it('Hebrew asked: Hebrew words', async () => {
    headers.mockResolvedValue({ authorization: 'Bearer t' });
    get.mockRejectedValue(new Error('not an admin'));
    fetchMock.mockResolvedValue(
      upstream(['timestamp,action\n"2026-10-08T09:00:00Z","ai.responded","ai",,,,\n']),
    );
    const text = await (await GET(request('?locale=he'))).text();
    expect(text).toContain('"מתי"');
    expect(text).toContain('"לא נרשם"');
  });
});
