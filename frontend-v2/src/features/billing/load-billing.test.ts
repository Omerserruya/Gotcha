import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const { get, routes } = vi.hoisted(() => {
  const routes: string[] = [];
  return {
    routes,
    // Every read fails: the routes asked for are the subject, not the answers.
    get: vi.fn(async ({ endpoint }: { endpoint: { route: string } }) => {
      routes.push(endpoint.route);
      throw new Error('not served in this test');
    }),
  };
});
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));
vi.mock('@/observability/logger', () => ({ logger: { warn: vi.fn() } }));

import { loadBilling } from './load-billing';

beforeEach(() => {
  routes.length = 0;
  get.mockClear();
});

describe('★ 17 reads no usage breakdown - it fed only "Where credits went" (Omer, 2026-10-11)', () => {
  it('asks for the billing reads and never for /api/usage/breakdown', async () => {
    const data = await loadBilling();
    // The reads that stay, so an empty list cannot pass for "no breakdown".
    expect(routes).toEqual(
      expect.arrayContaining([
        '/api/billing/subscription',
        '/api/billing/invoices',
        '/api/billing/credit-summary',
      ]),
    );
    expect(routes.filter((route) => route.includes('usage'))).toEqual([]);
    expect(data).not.toHaveProperty('breakdown');
  });
});
