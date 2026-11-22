import { describe, expect, it } from 'vitest';

import {
  appLinkBody,
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
        status: 'link_sent',
        shopDomain: 's.myshopify.com',
        installLink: 'https://evil.example/x',
      })?.installLink,
    ).toBeNull();
    expect(merchantRequestReadSchema.parse(null)).toBeNull();
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
    [400, 'invalid_link'],
    [409, 'wrong_state'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [500, 'failed'],
  ] as const)('console %i -> %s', (status, want) => {
    expect(consoleRefusalOf(status)).toBe(want);
  });
});
