import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/*
 * One tenant's page: five reads, each with its own failure. Mocked; the
 * fixtures are the routes' shapes (system.ts:172, :880; admin-coupons.ts;
 * coupon.service.ts:134, :288; admin-pricing.ts:1085).
 */
const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => api }));
vi.mock('@/observability/logger', () => ({ logger: { warn: vi.fn() } }));

import { loadTenant } from './load-tenant';

const tenant = (planAccess: object) => ({
  id: 't1',
  name: 'Acme',
  slug: 'acme',
  status: 'ACTIVE',
  isActive: true,
  createdAt: '2026-10-01T09:00:00.000Z',
  botEnabled: true,
  _count: {
    users: 3,
    conversations: 9,
    messages: 80,
    channelAccounts: 2,
    departments: 1,
    chatbotFlows: 0,
  },
  users: [],
  channels: [
    {
      id: 'c1',
      channel: 'WHATSAPP',
      displayName: 'Acme WA',
      connectionStatus: 'CONNECTED',
      isActive: true,
    },
  ],
  departments: [],
  planAccess: {
    state: 'ACTIVE_PAID',
    label: 'Paid plan',
    source: 'PAID',
    active: true,
    planKey: 'growth',
    planName: 'Growth',
    expiresAt: null,
    needsReview: false,
    reviewReason: null,
    ...planAccess,
  },
});
const coupon = (id: string, active: boolean) => ({
  id,
  code: id.toUpperCase(),
  nameEn: 'Launch',
  nameHe: null,
  discountType: 'PERCENT',
  percentOff: 20,
  amountOff: null,
  currency: null,
  defaultDurationMonths: 12,
  active,
  maxRedemptions: null,
  redemptionCount: 0,
  assignmentCount: 0,
  internalNote: null,
  label: '20% off',
  createdAt: '2026-10-01T09:00:00.000Z',
});

function serve(answers: Record<string, unknown>) {
  api.get.mockImplementation(
    async (request: {
      endpoint: { path: string };
      raw?: boolean;
      payload: { parse: (v: unknown) => unknown };
    }) => {
      const answer = answers[request.endpoint.path];
      if (answer === undefined) throw new Error(`unexpected ${request.endpoint.path}`);
      if (answer instanceof Error) throw answer;
      const body =
        !request.raw && typeof answer === 'object' && answer !== null && 'data' in answer
          ? (answer as { data: unknown }).data
          : answer;
      return request.payload.parse(body);
    },
  );
}

const base = (planAccess: object = {}) => ({
  '/api/system/tenants/t1': { data: tenant(planAccess) },
  '/api/system/tenants/t1/billing-provisioning': { data: null },
  '/api/admin/coupons/tenants/t1': { assignments: [] },
  '/api/admin/coupons': { coupons: [coupon('a', true), coupon('b', false)] },
});

beforeEach(() => {
  api.get.mockReset();
});

describe('★★ loadTenant', () => {
  it('★ the tenant, its provisioning (none), its coupons and the active coupons to give', async () => {
    serve(base());
    const data = await loadTenant('t1');
    expect(data.tenant.ok && data.tenant.value).toMatchObject({
      name: 'Acme',
      _count: { messages: 80, departments: 1 },
      channels: [{ channel: 'WHATSAPP', displayName: 'Acme WA', connectionStatus: 'CONNECTED' }],
      planAccess: { planName: 'Growth' },
    });
    expect(data.provisioning).toBeNull();
    expect(data.coupons).toEqual([]);
    expect(data.assignable?.map((c) => c.id)).toEqual(['a']);
  });

  it('★ plans are read only for a tenant that needs one - not for two plans, not for a paying one', async () => {
    const plansRoute = {
      '/api/admin/pricing/provisioning/plans': {
        data: [{ id: 'pv1', key: 'growth', name: 'Growth' }],
      },
    };
    const askedForPlans = () =>
      api.get.mock.calls.some(
        (call) => call[0].endpoint.path === '/api/admin/pricing/provisioning/plans',
      );
    serve({ ...base(), ...plansRoute });
    expect((await loadTenant('t1')).plans).toBeUndefined();
    expect(askedForPlans()).toBe(false);
    serve({ ...base({ state: 'CONFLICTING', active: true, needsReview: true }), ...plansRoute });
    expect((await loadTenant('t1')).plans).toBeUndefined();
    expect(askedForPlans()).toBe(false);
    serve({
      ...base({ state: 'MISSING', active: false, needsReview: true }),
      '/api/admin/pricing/provisioning/plans': {
        data: [{ id: 'pv1', key: 'growth', version: 2, name: 'Growth', basePrice: '499' }],
      },
    });
    expect((await loadTenant('t1')).plans).toEqual([{ id: 'pv1', key: 'growth', name: 'Growth' }]);
  });

  it('★★ a missing tenant and an unread one are two answers', async () => {
    serve({
      ...base(),
      '/api/system/tenants/t1': new ApiError({ kind: 'not_found', status: 404 }),
    });
    expect((await loadTenant('t1')).tenant).toEqual({ ok: false, missing: true });
    serve({ ...base(), '/api/system/tenants/t1': new ApiError({ kind: 'server', status: 500 }) });
    expect((await loadTenant('t1')).tenant).toEqual({ ok: false, missing: false });
  });

  it('★★ a failed read is undefined - never "none"', async () => {
    serve({
      ...base(),
      '/api/system/tenants/t1/billing-provisioning': new ApiError({ kind: 'server', status: 500 }),
      '/api/admin/coupons/tenants/t1': new ApiError({ kind: 'server', status: 500 }),
      '/api/admin/coupons': new ApiError({ kind: 'server', status: 500 }),
    });
    const data = await loadTenant('t1');
    expect(data.tenant.ok).toBe(true);
    expect(data.provisioning).toBeUndefined();
    expect(data.coupons).toBeUndefined();
    expect(data.assignable).toBeUndefined();
  });
});
