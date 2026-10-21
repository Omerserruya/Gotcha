import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/*
 * `GET /api/system/tenants` and the per-tenant provisioning read. Mocked - no
 * request is made. The fixtures are the routes' own shapes (system.ts:101-165,
 * :880 and billing-provisioning.service.ts:269).
 */
const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => api }));
vi.mock('@/observability/logger', () => ({ logger: { warn: vi.fn() } }));

import { loadTenants, TENANT_PAGE_SIZE } from './load-tenants';

const row = (id: string, status: string) => ({
  id,
  name: `Org ${id}`,
  slug: `org-${id}`,
  status,
  isActive: true,
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
  _count: { users: 3, conversations: 2, channelAccounts: 1 },
  planAccess: {
    state: 'PENDING_PAYMENT',
    label: 'Pending payment',
    source: 'NONE',
    active: false,
    planKey: 'growth',
    expiresAt: null,
    needsReview: false,
    reviewReason: null,
  },
});
const completed = {
  id: 'req-1',
  state: 'COMPLETED',
  mode: 'PAID_PLAN',
  planVersionId: 'pv-1',
  attemptCount: 1,
  lastAttemptAt: '2026-10-01T09:00:00.000Z',
  lastFailureCode: null,
  lastFailureMessage: null,
  canRepair: false,
  canResend: true,
};

/**
 * Answers each call by its route, as the client would: a top-level `data` is
 * unwrapped unless the call is `raw` (http-client.ts), then the loader's own
 * schema parses it.
 */
function serve(answers: Record<string, unknown>) {
  api.get.mockImplementation(
    async (request: {
      endpoint: { path: string };
      raw?: boolean;
      payload: { parse: (v: unknown) => unknown };
    }) => {
      const answer = answers[request.endpoint.path];
      if (answer instanceof Error) throw answer;
      const body =
        !request.raw && typeof answer === 'object' && answer !== null && 'data' in answer
          ? (answer as { data: unknown }).data
          : answer;
      return request.payload.parse(body);
    },
  );
}

beforeEach(() => {
  api.get.mockReset();
});

describe('★★ loadTenants', () => {
  it('★ asks for the page and the search, raw - `data` has a `meta` beside it', async () => {
    serve({ '/api/system/tenants': { data: [], meta: { total: 0, page: 1, limit: 50 } } });
    await loadTenants('acme');
    expect(api.get.mock.calls[0]![0]).toMatchObject({
      endpoint: { path: '/api/system/tenants' },
      query: { search: 'acme', limit: TENANT_PAGE_SIZE },
      raw: true,
    });
  });

  it('★★ reads provisioning for awaiting-payment tenants only, each its own answer', async () => {
    serve({
      '/api/system/tenants': {
        data: [row('a', 'ACTIVE'), row('b', 'PENDING_PAYMENT'), row('c', 'PENDING_PAYMENT')],
        meta: { total: 120, page: 1, limit: 50 },
      },
      '/api/system/tenants/b/billing-provisioning': { data: completed },
      '/api/system/tenants/c/billing-provisioning': { data: null },
    });
    const list = await loadTenants('');
    expect(list.ok && list.total).toBe(120);
    const paths = api.get.mock.calls.map((call) => call[0].endpoint.path);
    expect(paths).not.toContain('/api/system/tenants/a/billing-provisioning');
    expect(list.ok && list.provisioning).toEqual({
      b: expect.objectContaining({ state: 'COMPLETED' }),
      c: null,
    });
  });

  it('★★ a provisioning read that failed is left out - not written as "no request"', async () => {
    serve({
      '/api/system/tenants': { data: [row('b', 'PENDING_PAYMENT')], meta: null },
      '/api/system/tenants/b/billing-provisioning': new ApiError({ kind: 'server', status: 500 }),
    });
    const list = await loadTenants('');
    expect(list.ok).toBe(true);
    expect(list.ok && Object.hasOwn(list.provisioning, 'b')).toBe(false);
  });

  it('★ the list unread is its own answer, not an empty list', async () => {
    serve({ '/api/system/tenants': new ApiError({ kind: 'server', status: 500 }) });
    expect(await loadTenants('')).toEqual({ ok: false });
  });

  it('a row without its plan verdict or counts still reads - drawn as unknown, not dropped', async () => {
    const bare = { ...row('d', 'ACTIVE'), planAccess: null, _count: undefined };
    serve({ '/api/system/tenants': { data: [bare], meta: { total: 1, page: 1, limit: 50 } } });
    const list = await loadTenants('');
    expect(list.ok && list.tenants[0]).toMatchObject({
      planAccess: null,
      _count: { users: null, conversations: null, channelAccounts: null },
    });
  });
});
