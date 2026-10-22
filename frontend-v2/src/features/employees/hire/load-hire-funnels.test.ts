import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/* Nothing reaches a server: the reads are replaced. */
const get = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));

import { loadHireFunnels } from './load-hire-funnels';

type Read = { endpoint: { path: string }; payload: { parse: (v: unknown) => unknown } };
const answer = (by: Record<string, unknown>) =>
  get.mockImplementation(async ({ endpoint, payload }: Read) => {
    const value = by[endpoint.path];
    if (value instanceof Error) throw value;
    return payload.parse(value);
  });

beforeEach(() => {
  get.mockReset();
});

const TEMPLATE = {
  id: 'saas-default',
  name: 'Software and digital products',
  description: 'From a new lead, through a demo, to closing',
  stages: [{ id: 'lead', label: 'Lead' }],
};

describe('★★ H8c - the funnels a Sales hire may follow, and the ready-made ones', () => {
  it('the active rows, by their id, named by the slug made readable (no name column); the templates as given', async () => {
    answer({
      '/api/funnels': [
        { id: 'r1', funnelId: 'b2b_sales', isActive: true, departmentId: null, stages: [] },
        { id: 'r2', funnelId: 'old_flow', isActive: false },
        { id: 'r3', funnelId: 'x', name: 'Wholesale', isActive: true },
        { broken: true },
      ],
      '/api/funnels/templates': [TEMPLATE, { id: '' }],
    });
    expect(await loadHireFunnels()).toEqual({
      funnels: [
        { id: 'r1', name: 'B2b sales' },
        { id: 'r3', name: 'Wholesale' },
      ],
      templates: [TEMPLATE],
    });
  });

  it('★ refused (403) and failed are each their own, never "none" - and one leaves the other', async () => {
    answer({
      '/api/funnels': new ApiError({ kind: 'authorization', status: 403 }),
      '/api/funnels/templates': new ApiError({ kind: 'server', status: 500 }),
    });
    expect(await loadHireFunnels()).toEqual({ funnels: 'forbidden', templates: 'failed' });
    answer({
      '/api/funnels': new ApiError({ kind: 'server', status: 500 }),
      '/api/funnels/templates': [TEMPLATE],
    });
    expect(await loadHireFunnels()).toEqual({ funnels: 'failed', templates: [TEMPLATE] });
  });
});
