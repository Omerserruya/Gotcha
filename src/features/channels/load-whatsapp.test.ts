import { beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));

import { loadChannelsConfig } from './load-whatsapp';

beforeEach(() => {
  get.mockReset();
});

describe('★★ one read: both launches, and which providers are set up', () => {
  it('reads embeddedSignupByMode and providers', async () => {
    get.mockImplementation(async ({ payload }: { payload: { parse: (v: unknown) => unknown } }) =>
      payload.parse({
        embeddedSignup: { configId: 'd', configured: true },
        embeddedSignupByMode: {
          coexistence: { configId: 'c1', configured: true, inspectPath: 'business-app' },
          new_number: { configId: 'n1', configured: true, inspectPath: 'new' },
        },
        providers: { outlook: false, gmail: true },
      }),
    );
    const config = await loadChannelsConfig();
    expect(config.launches.coexistence?.configId).toBe('c1');
    expect(config.launches.coexistence?.inspectPath).toBe('business-app');
    expect(config.launches.newNumber?.configId).toBe('n1');
    expect(config.providers).toEqual({ outlook: false, gmail: true });
    expect((get.mock.calls[0]![0] as { endpoint: { path: string } }).endpoint.path).toBe(
      '/api/channels/config',
    );
  });

  it('unread: no launches, no providers - never "not set up"', async () => {
    get.mockRejectedValue(new Error('down'));
    expect(await loadChannelsConfig()).toEqual({
      launches: { coexistence: null, newNumber: null },
      providers: null,
    });
  });
});
