import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get, post }) }));
vi.mock('@/observability/logger', () => ({ logger: { warn } }));

import { loadMessengerPages, selectMessengerPages } from './messenger-actions';

type Call = { endpoint: { path: string }; body?: unknown; raw?: boolean };
const SESSION = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  warn.mockReset();
});
const refuse = (init: ConstructorParameters<typeof ApiError>[0]) => async () => {
  throw new ApiError(init);
};

describe('★★ the Pages to choose from, at the wire', () => {
  it('GET /api/channels/messenger/candidates?session=<uuid>, enveloped (no raw)', async () => {
    get.mockResolvedValue({ pages: [{ id: 'p1', name: 'Shop' }] });
    expect(await loadMessengerPages(SESSION)).toEqual({
      ok: true,
      pages: [{ id: 'p1', name: 'Shop' }],
    });
    const call = get.mock.calls[0]![0] as Call;
    expect(call.endpoint.path).toBe(`/api/channels/messenger/candidates?session=${SESSION}`);
    expect(call.raw).toBeUndefined();
  });

  it('the session is encoded, never spliced', async () => {
    get.mockResolvedValue({ pages: [] });
    await loadMessengerPages('a&platform=x');
    expect((get.mock.calls[0]![0] as Call).endpoint.path).toBe(
      '/api/channels/messenger/candidates?session=a%26platform%3Dx',
    );
  });

  it('★ 410 SESSION_EXPIRED is "expired"; 403 forbidden; anything else failed', async () => {
    get.mockImplementation(
      refuse({ kind: 'unknown', status: 410, code: 'SESSION_EXPIRED', developerMessage: 'x' }),
    );
    expect(await loadMessengerPages(SESSION)).toEqual({ ok: false, reason: 'expired' });
    get.mockImplementation(refuse({ kind: 'authorization', status: 403 }));
    expect(await loadMessengerPages(SESSION)).toEqual({ ok: false, reason: 'forbidden' });
    get.mockImplementation(refuse({ kind: 'server', status: 500 }));
    expect(await loadMessengerPages(SESSION)).toEqual({ ok: false, reason: 'failed' });
  });

  it('the log carries a status and a code, never the session', async () => {
    get.mockImplementation(refuse({ kind: 'unknown', status: 410, code: 'SESSION_EXPIRED' }));
    await loadMessengerPages(SESSION);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SESSION);
    expect(warn).toHaveBeenCalledWith('channels.messenger_pages_failed', {
      status: 410,
      code: 'SESSION_EXPIRED',
    });
  });
});

describe('★★ connecting the chosen Pages, at the wire', () => {
  it('POST /api/channels/messenger/select { session, pageIds } - each id once', async () => {
    post.mockResolvedValue({
      results: [{ id: 'p1', name: 'Shop', status: 'connected', subscribed: true }],
    });
    expect(await selectMessengerPages(SESSION, ['p1', 'p2', 'p1'])).toEqual({
      ok: true,
      results: [{ id: 'p1', name: 'Shop', status: 'connected', subscribed: true }],
    });
    const call = post.mock.calls[0]![0] as Call;
    expect(call.endpoint.path).toBe('/api/channels/messenger/select');
    expect(call.body).toEqual({ session: SESSION, pageIds: ['p1', 'p2'] });
    expect(call.raw).toBeUndefined();
  });

  it('nothing chosen, or more than the route takes: nothing asked', async () => {
    expect(await selectMessengerPages(SESSION, [])).toEqual({
      ok: false,
      reason: 'failed',
      results: [],
    });
    const many = Array.from({ length: 51 }, (_, i) => `p${i}`);
    expect((await selectMessengerPages(SESSION, many)).ok).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: 'unknown', status: 410, code: 'SESSION_EXPIRED' }, 'expired'],
    [{ kind: 'tenant_inactive', status: 402, code: 'PLAN_LIMIT_REACHED', limit: 3 }, 'limit'],
    [{ kind: 'validation', status: 422, code: 'UNKNOWN_PAGE' }, 'unknown_page'],
    [{ kind: 'authorization', status: 403 }, 'forbidden'],
    // The TENANT gate's 402 is not the plan's limit.
    [{ kind: 'tenant_inactive', status: 402, code: 'TENANT_SUSPENDED' }, 'failed'],
    [{ kind: 'server', status: 500 }, 'failed'],
    [{ kind: 'validation', status: 400 }, 'failed'],
  ] as const)('%o → %s', async (init, reason) => {
    post.mockImplementation(refuse(init));
    expect(await selectMessengerPages(SESSION, ['p1'])).toEqual({
      ok: false,
      reason,
      results: [],
    });
  });

  it('★ 409 NONE_CONNECTED: refused, with the route’s per-Page answers from beside its code', async () => {
    post.mockImplementation(
      refuse({
        kind: 'conflict',
        status: 409,
        code: 'NONE_CONNECTED',
        errorData: {
          results: [{ id: 'p1', name: 'Shop', status: 'taken', subscribed: false }],
          connected: 0,
        },
      }),
    );
    expect(await selectMessengerPages(SESSION, ['p1'])).toEqual({
      ok: false,
      reason: 'none_connected',
      results: [{ id: 'p1', name: 'Shop', status: 'taken', subscribed: false }],
    });
  });

  it('a 409 with no `data` is still "none connected"', async () => {
    post.mockImplementation(refuse({ kind: 'conflict', status: 409, code: 'NONE_CONNECTED' }));
    expect(await selectMessengerPages(SESSION, ['p1'])).toEqual({
      ok: false,
      reason: 'none_connected',
      results: [],
    });
  });

  it('the log never carries the session or the Page ids', async () => {
    post.mockImplementation(refuse({ kind: 'server', status: 500 }));
    await selectMessengerPages(SESSION, ['page-secret-id']);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(new RegExp(`${SESSION}|page-secret-id`));
  });
});
