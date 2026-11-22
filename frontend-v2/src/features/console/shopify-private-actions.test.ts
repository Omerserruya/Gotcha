import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const post = vi.hoisted(() => vi.fn());
const put = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ post, put }) }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/observability/logger', () => ({ logger: { warn, info: vi.fn(), error: vi.fn() } }));

const actions = await import('./shopify-private-actions');
const FORM = {
  clientId: 'cid',
  clientSecret: 'shpss_TOPSECRET',
  installLink: 'https://admin.shopify.com/oauth/install_custom_app?client_id=cid',
  linkExpiresAt: '',
};

beforeEach(() => {
  post.mockReset().mockResolvedValue({});
  put.mockReset().mockResolvedValue({});
  warn.mockReset();
});

describe('★★ the link: stored and emailed in one call', () => {
  it('posts the app to the tenant’s link step', async () => {
    expect(await actions.sendShopifyCustomAppLink('t1', FORM)).toEqual({ ok: true });
    const call = post.mock.calls[0]![0] as { endpoint: { path: string }; body: unknown };
    expect(call.endpoint.path).toBe('/api/system/shopify-custom-apps/t1/link');
    expect(call.body).toStrictEqual({
      clientId: 'cid',
      clientSecret: 'shpss_TOPSECRET',
      installLink: FORM.installLink,
    });
  });

  it('★ beaecd42: the answer says whether the email went out', async () => {
    post.mockResolvedValueOnce({ tenantId: 't1', status: 'link_sent', emailed: false });
    expect(await actions.sendShopifyCustomAppLink('t1', FORM)).toEqual({
      ok: true,
      emailed: false,
    });
  });

  it('a link that is not Shopify’s admin, or a missing secret: nothing sent', async () => {
    expect(
      await actions.sendShopifyCustomAppLink('t1', {
        ...FORM,
        installLink: 'https://evil.example/',
      }),
    ).toEqual({ ok: false, reason: 'invalid_link' });
    expect(await actions.sendShopifyCustomAppLink('t1', { ...FORM, clientSecret: ' ' })).toEqual({
      ok: false,
      reason: 'invalid_link',
    });
    expect(post).not.toHaveBeenCalled();
  });

  it('★★ a refusal logs the status alone - never the secret, never the request', async () => {
    const cause = new ApiError({ kind: 'conflict', status: 409, developerMessage: 'wrong_state' });
    post.mockRejectedValueOnce(cause);
    expect(await actions.sendShopifyCustomAppLink('t1', FORM)).toEqual({
      ok: false,
      reason: 'wrong_state',
    });
    expect(warn).toHaveBeenCalledWith('console.shopify_custom_app_link_failed', {
      status: 409,
      code: 'wrong_state',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('TOPSECRET');
  });
});

describe('★ the other steps', () => {
  it('new link, revoke and grant go to their own step', async () => {
    await actions.sendShopifyCustomAppNewLink('t1', FORM.installLink, '2026-12-01');
    await actions.shopifyCustomAppStep('t1', 'revoke');
    await actions.shopifyCustomAppStep('t1', 'grant');
    expect(
      post.mock.calls.map((c) => (c[0] as { endpoint: { path: string } }).endpoint.path),
    ).toEqual([
      '/api/system/shopify-custom-apps/t1/new-link',
      '/api/system/shopify-custom-apps/t1/revoke',
      '/api/system/shopify-custom-apps/t1/grant',
    ]);
    expect((post.mock.calls[0]![0] as { body: unknown }).body).toStrictEqual({
      installLink: FORM.installLink,
      linkExpiresAt: '2026-12-01T23:59:59.000Z',
    });
  });

  it('the switch and the entitlement are put together', async () => {
    expect(
      await actions.saveShopifyPrivateAppsSettings({ enabled: true, entitlement: 'manual' }),
    ).toEqual({ ok: true });
    const call = put.mock.calls[0]![0] as { endpoint: { path: string }; body: unknown };
    expect(call.endpoint.path).toBe('/api/system/shopify-private-apps');
    expect(call.body).toStrictEqual({ enabled: true, entitlement: 'manual' });
  });
});
