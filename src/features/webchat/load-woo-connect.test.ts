import { beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));

import { loadWooConnect } from './load-woo-connect';

type Call = { endpoint: { path: string }; payload: { parse: (v: unknown) => unknown } };

const answers = (integrations: unknown) =>
  get.mockImplementation(async ({ endpoint, payload }: Call) => {
    if (endpoint.path === '/api/auth/me') {
      return payload.parse({ id: 'u1', email: 'a@b.c', tenantName: 'Aviv' });
    }
    // The client unwraps `data` before the schema sees it.
    if (endpoint.path === '/api/integrations') return payload.parse(integrations);
    return payload.parse({
      data: {
        settings: undefined,
        places: { code: { channelId: 'wc1' }, shopify: [] },
      },
    });
  });

const woo = (tenantConnection: unknown) => [
  {
    id: 'i1',
    slug: 'woocommerce',
    name: 'WooCommerce',
    authType: 'OAUTH2',
    authSchema: {},
    tenantConnection,
  },
];

beforeEach(() => {
  get.mockReset();
});

describe('the connect page’s read: the workspace, its store, its web chat', () => {
  it('a connected store: its address, from the connection’s config', async () => {
    answers(
      woo({ id: 'c1', status: 'CONNECTED', config: { storeUrl: 'https://shop.example.com' } }),
    );
    expect((await loadWooConnect()).store).toBe('https://shop.example.com');
  });

  it('★ connected, but no address to read: unknown - binding says, never "not connected"', async () => {
    answers(woo({ id: 'c1', status: 'CONNECTED', config: {} }));
    expect((await loadWooConnect()).store).toBeNull();
  });

  it('not connected (or not finished): none', async () => {
    answers(woo({ id: 'c1', status: 'PENDING', config: { storeUrl: 'https://shop.example.com' } }));
    expect((await loadWooConnect()).store).toBe('none');
    answers([]);
    expect((await loadWooConnect()).store).toBe('none');
  });
});
