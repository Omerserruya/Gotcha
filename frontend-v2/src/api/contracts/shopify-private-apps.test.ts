import { describe, expect, it } from 'vitest';

import {
  appLinkBody,
  consoleListSchema,
  consoleRefusalOf,
  isShopifyInstallLink,
  merchantRequestReadSchema,
  myshopifyOf,
  requestRefusalOf,
} from './shopify-private-apps';

describe('★★ the store address, as typed', () => {
  it.each([
    ['my-store.myshopify.com', 'my-store.myshopify.com'],
    ['  My-Store.MyShopify.com ', 'my-store.myshopify.com'],
    ['https://my-store.myshopify.com/admin', 'my-store.myshopify.com'],
    ['my-store', 'my-store.myshopify.com'],
  ])('%j -> %s', (raw, want) => {
    expect(myshopifyOf(raw)).toBe(want);
  });

  it.each(['', 'my-store.com', 'shop.example.myshopify.com.evil.com', '-x.myshopify.com', 'a b'])(
    '%j is no store address',
    (raw) => {
      expect(myshopifyOf(raw)).toBeNull();
    },
  );
});

describe('★★ an install link is Shopify’s admin, https only', () => {
  it.each([
    ['https://admin.shopify.com/oauth/install_custom_app?client_id=x', true],
    ['http://admin.shopify.com/x', false],
    ['https://admin.shopify.com.evil.com/x', false],
    ['https://apps.shopify.com/gotcha', false],
    ['not a url', false],
  ])('%s -> %s', (raw, want) => {
    expect(isShopifyInstallLink(raw)).toBe(want);
  });

  it('a link the server sends that is not one is dropped, never drawn as a button', () => {
    expect(
      merchantRequestReadSchema.parse({
        data: {
          status: 'link_sent',
          shopDomain: 's.myshopify.com',
          installLink: 'https://evil.example/x',
        },
        enabled: true,
      })?.installLink,
    ).toBeNull();
    // beaecd42: `{ data: null, enabled }` is "no request", read whole.
    expect(merchantRequestReadSchema.parse({ data: null, enabled: true })).toBeNull();
  });
});

describe('★ bodies and refusals', () => {
  it('the link body is trimmed; an empty expiry is left out, a day is its end in UTC', () => {
    const form = {
      clientId: ' id ',
      clientSecret: ' s ',
      installLink: ' https://admin.shopify.com/x ',
    };
    expect(appLinkBody({ ...form, linkExpiresAt: '' })).toStrictEqual({
      clientId: 'id',
      clientSecret: 's',
      installLink: 'https://admin.shopify.com/x',
    });
    expect(appLinkBody({ ...form, linkExpiresAt: '2026-12-01' }).linkExpiresAt).toBe(
      '2026-12-01T23:59:59.000Z',
    );
  });

  it.each([
    [400, 'invalid_shop_domain', 'invalid_shop_domain'],
    [409, 'already_requested', 'already_requested'],
    [409, 'shop_requested_elsewhere', 'shop_requested_elsewhere'],
    [409, 'store_connected', 'store_connected'],
    [403, 'private_apps_off', 'private_apps_off'],
    [403, 'forbidden', 'forbidden'],
    [500, undefined, 'failed'],
  ] as const)('merchant %i %s -> %s', (status, code, want) => {
    expect(requestRefusalOf(status, code)).toBe(want);
  });

  it.each([
    [400, 'invalid_client_id', 'invalid_client_id'],
    [400, 'invalid_client_secret', 'invalid_client_secret'],
    [400, 'invalid_install_link', 'invalid_link'],
    [409, 'client_id_in_use', 'client_id_in_use'],
    [409, 'not_waiting_for_a_link', 'wrong_state'],
    [409, 'no_link_to_replace', 'wrong_state'],
    [409, 'nothing_to_revoke', 'wrong_state'],
    [409, 'not_installed', 'wrong_state'],
    [403, undefined, 'forbidden'],
    [404, undefined, 'not_found'],
    [500, undefined, 'failed'],
  ] as const)('console %i %s -> %s (beaecd42)', (status, code, want) => {
    expect(consoleRefusalOf(status, code)).toBe(want);
  });

  it('the console list is read whole: its rows, and the settings beside them', () => {
    const list = consoleListSchema.parse({
      data: [
        {
          tenantId: 't1',
          status: 'installed',
          revokedAt: null,
          linkSentAt: '2026-11-22T00:00:00Z',
        },
      ],
      settings: { enabled: true, entitlement: 'manual' },
    });
    expect(list.data[0]).toMatchObject({ tenantId: 't1', linkSentAt: '2026-11-22T00:00:00Z' });
    expect(list.settings).toEqual({ enabled: true, entitlement: 'manual' });
    expect(consoleListSchema.parse({ data: [] }).settings).toBeNull();
  });
});
