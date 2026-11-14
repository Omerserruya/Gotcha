import { describe, expect, it } from 'vitest';

import { foundOn, installWay } from './install-way';

/** The website row's first way (Omer, 2026-11-11; slugs per Backend, learned.ts:70). */
const install = (over: object = {}) =>
  ({ code: null, shopify: [], woocommerce: { sites: [] }, platforms: null, ...over }) as never;
const shop = (status: string) => ({ channelId: 's', shopDomain: 'a.myshopify.com', status });
const site = (status: string) => ({ id: 'w', siteUrl: 'https://a.co.il', status });

describe('★★ installWay: proof first, then the read, else the code', () => {
  it.each([
    ['shopify', 'shopify'],
    ['woocommerce', 'woocommerce'],
    ['WooCommerce', 'woocommerce'],
    [' shopify ', 'shopify'],
    // Backend: plain WordPress is never its own value; these are the read's other slugs.
    ['wix', 'code'],
    ['magento', 'code'],
    ['bigcommerce', 'code'],
    ['squarespace', 'code'],
    ['webflow', 'code'],
    ['wordpress', 'code'],
    ['', 'code'],
    [null, 'code'],
  ])('read %j → %s', (detected, way) => {
    expect(installWay(install(), detected)).toBe(way);
  });

  it('★ a shop the chat is installed in outranks the read; an uninstalled one does not', () => {
    expect(installWay(install({ shopify: [shop('not_enabled')] }), 'woocommerce')).toBe('shopify');
    expect(installWay(install({ shopify: [shop('uninstalled')] }), 'woocommerce')).toBe(
      'woocommerce',
    );
  });

  it('★ a plugin site that is not removed outranks the read; a removed one does not', () => {
    expect(installWay(install({ woocommerce: { sites: [site('deactivated')] } }), null)).toBe(
      'woocommerce',
    );
    expect(installWay(install({ woocommerce: { sites: [site('removed')] } }), 'shopify')).toBe(
      'shopify',
    );
  });

  it('the install unread: the read alone decides', () => {
    expect(installWay(null, 'shopify')).toBe('shopify');
    expect(installWay(null, null)).toBe('code');
  });
});

describe('★ foundOn: "we found" is said only when the read IS the reason', () => {
  it.each([
    ['shopify', 'shopify', 'shopify'],
    ['woocommerce', 'WooCommerce', 'woocommerce'],
    ['shopify', 'woocommerce', null],
    ['shopify', null, null],
    ['code', 'wix', null],
  ] as const)('way %s, read %j → %j', (way, detected, said) => {
    expect(foundOn(way, detected)).toBe(said);
  });
});
