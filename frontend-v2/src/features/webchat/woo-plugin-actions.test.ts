import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const api = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn(), delete: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => api }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: async () => {} }));

import { bindWooPlugin, removeWooSite, startWooPluginStore } from './woo-plugin-actions';

const LINK = {
  site: 'https://shop.example.com',
  returnUrl: 'https://shop.example.com/wp-admin/admin.php?page=gotcha',
  nonce: 'n0nce_abcdef12',
};
const path = (call: unknown[]) => (call[0] as { endpoint: { path: string } }).endpoint.path;

beforeEach(() => {
  api.post.mockReset();
  api.get.mockReset();
  api.delete.mockReset();
});

describe('★★ bind: a one-time code, and back to WordPress', () => {
  it('POST /bind with the site, the way back and the nonce; the redirect followed', async () => {
    api.post.mockResolvedValue({ redirect: `${LINK.returnUrl}&gotcha_code=c&nonce=n` });
    expect(await bindWooPlugin(LINK)).toEqual({
      ok: true,
      redirect: `${LINK.returnUrl}&gotcha_code=c&nonce=n`,
    });
    expect(api.post.mock.calls.map(path)).toEqual(['/api/woocommerce-plugin/bind']);
    expect(api.post.mock.calls[0]![0]).toMatchObject({
      body: { siteUrl: LINK.site, returnUrl: LINK.returnUrl, nonce: LINK.nonce },
    });
  });

  it('no web chat yet: it is created first, then bound', async () => {
    api.post.mockResolvedValue({ redirect: LINK.returnUrl });
    await bindWooPlugin(LINK, { createWidget: true });
    expect(api.post.mock.calls.map(path)).toEqual([
      '/api/channels/webchat/create',
      '/api/woocommerce-plugin/bind',
    ]);
  });

  it('★ a redirect anywhere but the store is not followed', async () => {
    api.post.mockResolvedValue({ redirect: 'https://evil.example/wp-admin/?gotcha_code=c' });
    expect(await bindWooPlugin(LINK)).toEqual({ ok: false, reason: 'failed' });
    api.post.mockResolvedValue({ redirect: 'javascript:alert(1)' });
    expect(await bindWooPlugin(LINK)).toEqual({ ok: false, reason: 'failed' });
    // Two `javascript:` addresses share the origin "null": the scheme is checked too.
    api.post.mockResolvedValue({ redirect: 'javascript:alert(2)' });
    expect(await bindWooPlugin({ ...LINK, returnUrl: 'javascript:alert(1)' })).toEqual({
      ok: false,
      reason: 'failed',
    });
  });

  it.each([
    [409, 'STORE_NOT_CONNECTED', 'store_not_connected'],
    [422, 'BAD_RETURN_URL', 'bad_return'],
    [422, 'BAD_NONCE', 'bad_nonce'],
    [409, 'WIDGET_NOT_CREATED', 'no_widget'],
    [403, undefined, 'forbidden'],
    [500, undefined, 'failed'],
  ])('%s %s → %s', async (status, code, reason) => {
    api.post.mockRejectedValue(new ApiError({ kind: 'conflict', status, code }));
    expect(await bindWooPlugin(LINK)).toEqual({ ok: false, reason });
  });
});

describe('the store approves first - the key flow that comes back to the page', () => {
  it('flow=wp_plugin, the store address normalised', async () => {
    api.get.mockResolvedValue({ url: 'https://shop.example.com/wc-auth/v1/authorize?x=1' });
    expect(await startWooPluginStore('https://shop.example.com/')).toEqual({
      ok: true,
      url: 'https://shop.example.com/wc-auth/v1/authorize?x=1',
    });
    expect(path(api.get.mock.calls[0]!)).toBe(
      '/api/integrations/woocommerce/oauth/init?storeUrl=https%3A%2F%2Fshop.example.com&flow=wp_plugin&format=json',
    );
  });

  it('not a store address: refused before any call', async () => {
    expect(await startWooPluginStore('not a url')).toEqual({ ok: false, reason: 'invalid_store' });
    expect(api.get).not.toHaveBeenCalled();
  });
});

describe('Disconnect a site', () => {
  it('DELETE /sites/:id; a site already gone, forbidden, failed', async () => {
    api.delete.mockResolvedValueOnce({ removed: true });
    expect(await removeWooSite('s1')).toEqual({ ok: true });
    expect(path(api.delete.mock.calls[0]!)).toBe('/api/woocommerce-plugin/sites/s1');
    api.delete.mockRejectedValueOnce(new ApiError({ kind: 'not_found', status: 404 }));
    expect(await removeWooSite('s1')).toEqual({ ok: false, reason: 'gone' });
    api.delete.mockRejectedValueOnce(new ApiError({ kind: 'authorization', status: 403 }));
    expect(await removeWooSite('s1')).toEqual({ ok: false, reason: 'forbidden' });
    api.delete.mockRejectedValueOnce(new ApiError({ kind: 'server', status: 500 }));
    expect(await removeWooSite('s1')).toEqual({ ok: false, reason: 'failed' });
  });
});
