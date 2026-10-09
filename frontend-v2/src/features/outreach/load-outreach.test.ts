import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const get = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));
vi.mock('server-only', () => ({}));

// Braces: an arrow that RETURNS the mock hands vitest a function, which it runs as a teardown.
beforeEach(() => {
  get.mockReset();
});

describe('★ loadCampaign - three answers', () => {
  it('the campaign, read through the real contract', async () => {
    get.mockImplementation(async (req: { payload: { parse: (x: unknown) => unknown } }) =>
      req.payload.parse({
        id: 'b1',
        name: 'Restock',
        status: 'COMPLETED',
        createdAt: '2026-10-02T08:00:00.000Z',
      }),
    );
    const { loadCampaign } = await import('./load-outreach');
    const read = await loadCampaign('b1');
    expect(read.state).toBe('ok');
    expect(read.state === 'ok' && read.campaign.name).toBe('Restock');
  });

  it('★ a 404 is "missing" - a fact about the id, not our failure', async () => {
    get.mockRejectedValue(new ApiError({ kind: 'not_found', status: 404 }));
    const { loadCampaign } = await import('./load-outreach');
    expect(await loadCampaign('nope')).toEqual({ state: 'missing' });
  });

  it('⚠ anything else is "failed" - never "missing"', async () => {
    get.mockRejectedValue(new ApiError({ kind: 'server', status: 500 }));
    const { loadCampaign } = await import('./load-outreach');
    expect(await loadCampaign('b1')).toEqual({ state: 'failed' });
  });
});
