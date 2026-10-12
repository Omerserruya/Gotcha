import { beforeEach, describe, expect, it, vi } from 'vitest';

/** I2's reads, mocked: what is asked, and what a failure becomes. */
const { get, warn } = vi.hoisted(() => ({ get: vi.fn(), warn: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));
vi.mock('@/observability/logger', () => ({ logger: { warn } }));

const { loadFilterChips } = await import('./load-filter-chips');
const { FALLBACK_FILTER_CHIPS } = await import('./inbox-views');

const woo = (status: string | null) => ({
  id: 'i1',
  slug: 'woocommerce',
  name: 'WooCommerce',
  tenantConnection: status === null ? null : { id: 't1', status },
});

beforeEach(() => {
  get.mockReset();
  warn.mockReset();
});

const answer = (states: unknown, integrations: unknown) =>
  get.mockImplementation(async ({ endpoint }: { endpoint: { path: string } }) => {
    if (endpoint.path === '/api/channels/state') {
      if (states instanceof Error) throw states;
      return states;
    }
    if (endpoint.path === '/api/integrations') {
      if (integrations instanceof Error) throw integrations;
      return integrations;
    }
    throw new Error(`unexpected ${endpoint.path}`);
  });

describe('★★ the chips from the workspace’s channels and its store', () => {
  it('★★ reads the member-readable state, not the managers’ list', async () => {
    answer([{ id: 'a', channel: 'WHATSAPP', connectionStatus: 'CONNECTED', isActive: true }], []);
    expect(await loadFilterChips(null)).toEqual([{ channel: 'WHATSAPP', mark: 'WHATSAPP' }]);
    expect(get.mock.calls.map(([r]) => r.endpoint.path).sort()).toEqual([
      '/api/channels/state',
      '/api/integrations',
    ]);
  });

  it('★★ a connected WooCommerce store puts its mark on web chat; a disconnected one does not', async () => {
    const web = [{ id: 'w', channel: 'WEBCHAT', connectionStatus: 'CONNECTED', isActive: true }];
    answer(web, [woo('CONNECTED')]);
    expect(await loadFilterChips(null)).toEqual([{ channel: 'WEBCHAT', mark: 'WOOCOMMERCE' }]);
    answer(web, [woo('DISCONNECTED')]);
    expect(await loadFilterChips(null)).toEqual([{ channel: 'WEBCHAT', mark: 'WEBCHAT' }]);
  });

  it('★ the channels unread: the row as it was, and logged', async () => {
    answer(new Error('down'), []);
    expect(await loadFilterChips(null)).toBe(FALLBACK_FILTER_CHIPS);
    expect(warn).toHaveBeenCalled();
  });

  it('the store unread: web chat keeps the globe', async () => {
    answer(
      [{ id: 'w', channel: 'WEBCHAT', connectionStatus: 'CONNECTED', isActive: true }],
      new Error('down'),
    );
    expect(await loadFilterChips(null)).toEqual([{ channel: 'WEBCHAT', mark: 'WEBCHAT' }]);
  });
});
