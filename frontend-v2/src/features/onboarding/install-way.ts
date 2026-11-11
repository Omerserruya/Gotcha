import type { WidgetInstall } from '@/api/contracts/website-widget';

/** The three ways the website chat goes on a site (13j): Shopify, the WooCommerce plugin, the code. */
export const INSTALL_WAYS = ['shopify', 'woocommerce', 'code'] as const;
export type InstallWay = (typeof INSTALL_WAYS)[number];

/**
 * The way offered first on step 3's website row (Omer, 2026-11-11).
 *
 * 1. A place the chat is already installed wins: a Shopify shop that was not
 *    uninstalled, or a WordPress site whose plugin was not removed. That is
 *    proof, the read is a guess.
 * 2. Otherwise the platform the website read found (`learned.platform`, the
 *    slug of `technology.platform`; Backend 2026-11-11): `shopify` or
 *    `woocommerce`.
 * 3. Anything else is the code: `null` (not found, or not read yet), plain
 *    WordPress (the read has no such value, it comes as `null`), Wix,
 *    Magento, BigCommerce, Squarespace, Webflow.
 */
export function installWay(install: WidgetInstall | null, detected: string | null): InstallWay {
  if (install?.shopify.some((shop) => shop.status !== 'uninstalled')) return 'shopify';
  if (install?.woocommerce.sites.some((site) => site.status !== 'removed')) return 'woocommerce';
  const slug = detected?.trim().toLowerCase();
  return slug === 'shopify' || slug === 'woocommerce' ? slug : 'code';
}

/** The platform the read found, when it is the reason for the way offered first. */
export function foundOn(way: InstallWay, detected: string | null): 'shopify' | 'woocommerce' | null {
  if (way === 'code') return null;
  return detected?.trim().toLowerCase() === way ? way : null;
}
