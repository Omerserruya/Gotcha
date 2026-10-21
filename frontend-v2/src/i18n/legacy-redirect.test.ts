import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { legacyLocale, legacyRedirect } from './legacy-redirect';

/*
 * Links to the old app are out there (emails, stored notifications, bookmarks,
 * the WooCommerce plugin's /v2 links). The old app is no longer served
 * (2026-10-21): every one must land on a screen here, never a 404.
 */
const LEGACY = join(__dirname, '../../../frontend/src/app');
const to = (path: string, locale: 'en' | 'he' | null = 'en') =>
  legacyRedirect(new URL(path, 'https://app.test'), locale);

function legacyPages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : legacyPages(path);
    if (name !== 'page.tsx') return [];
    const route = relative(LEGACY, dir).split(sep).join('/');
    // A sample value for each dynamic segment.
    return [`/${route}`.replace(/\[[^\]]+\]/g, 'x1').replace(/\/$/, '') || '/'];
  });
}

describe('★★ every page of the old app lands somewhere', () => {
  const pages = legacyPages(LEGACY);

  it('the walk reads the real legacy tree', () => {
    expect(pages.length).toBeGreaterThan(100);
    expect(pages).toEqual(
      expect.arrayContaining(['/conversations', '/join', '/system/tenants/x1']),
    );
  });

  it.each(pages)('%s: never answers itself, with or without a language (a loop)', (page) => {
    for (const locale of ['en', 'he', null] as const) {
      const target = to(page, locale);
      // Another host (marketing, help) is not this app: it cannot loop here.
      if (target === null || /^https?:/.test(target)) continue;
      // Following the redirect must not redirect again to the same place.
      expect(target, `${page} (${locale}) answers itself`).not.toBe(page);
      expect(to(target, locale), `${page} (${locale}) → ${target} → loops`).not.toBe(target);
    }
  });

  it.each(pages)('%s', (page) => {
    const target = to(page);
    expect(target, `${page} has no rule`).not.toBeNull();
    // Never back to itself unprefixed (a loop at the root).
    expect(target).not.toBe(page);
  });
});

describe('★★ every target is a page this app has', () => {
  /*
   * "Lands somewhere" passed while /settings/billing/credits pointed at a
   * route this app does not have: a 404 one hop later. Every in-app target
   * must match a page under src/app/[locale].
   */
  const V2 = join(__dirname, '../app/[locale]');
  const v2Routes = (dir: string): RegExp[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return v2Routes(path);
      if (name !== 'page.tsx') return [];
      const route = relative(V2, dir)
        .split(sep)
        .filter((part) => part && !/^\(.*\)$/.test(part))
        .map((part) => (/^\[.*\]$/.test(part) ? '[^/]+' : part))
        .join('/');
      return [new RegExp(`^/${route}$`)];
    });
  const routes = v2Routes(V2);
  /*
   * The console's pages, being built in parallel (2026-10-21). Listed, not
   * skipped: the last test fails the day they exist, so this list empties.
   */
  const PENDING = ['/system/tenants/x1', '/system/coupons'];

  it.each(legacyPages(LEGACY))('%s', (page) => {
    const target = to(page, 'en');
    if (!target || /^https?:/.test(target) || target.startsWith('/api/')) return;
    const path = target.replace(/^\/en(?=\/|$)/, '').replace(/\?.*$/, '') || '/';
    if (PENDING.includes(path)) return;
    expect(
      routes.some((r) => r.test(path)) || path === '/',
      `${page} → ${path}: no such page`,
    ).toBe(true);
  });

  it('the pending pages do not exist yet (when they do, empty PENDING)', () => {
    for (const path of PENDING) {
      expect(
        routes.some((r) => r.test(path)),
        `${path} exists now: remove it from PENDING`,
      ).toBe(false);
    }
  });
});

describe('★★ the links the platform sends', () => {
  it.each([
    // notifications templates.ts: conversation links (one shape never existed in the old app)
    ['/conversations/c42', '/en/inbox?c=c42'],
    ['/conversations?id=c42', '/en/inbox?c=c42'],
    ['/history?id=c42&x=1', '/en/inbox?c=c42&x=1'],
    ['/approvals?id=a7', '/en/approvals?id=a7'],
    ['/contacts/k9', '/en/customers/k9'],
    ['/settings/billing/credits', '/en/settings/billing'],
    ['/system/tenants/t9', '/en/system/tenants/t9'],
    ['/system/usage', '/en/system'],
    ['/settings/billing/details', '/en/settings/billing'],
    ['/settings/business-systems', '/en/settings/systems'],
    ['/ai-studio/knowledge?tab=discovered', '/en/studio/knowledge?tab=discovered'],
    ['/ai-studio/agents/e5', '/en/studio/employees/e5'],
    [
      '/ai-studio/marketplace/hubspot?status=connected',
      '/en/studio/capabilities?system=hubspot&connected=1',
    ],
    ['/integrations/zoho?error=denied', '/en/studio/capabilities?system=zoho&error=denied'],
    [
      '/channels?error=not_configured&platform=ig',
      '/en/settings/channels?error=not_configured&platform=ig',
    ],
    [
      '/integrations/shopify/billing/complete?shop=s.myshopify.com',
      '/en/studio/capabilities?system=shopify&billing=verify&shop=s.myshopify.com',
    ],
    ['/settings/permissions', '/en/settings/people/permissions'],
    ['/setup?connected=gmail', '/en/onboarding'],
    ['/', '/en/home'],
  ])('%s → %s', (from, expected) => {
    expect(to(from)).toBe(expected);
  });

  it('sign-in: next and redirect become returnTo; the old error codes are not ours', () => {
    expect(to('/login?next=%2Fsetup')).toBe('/en/sign-in?returnTo=%2Fsetup');
    expect(to('/login?redirect=%2Fapprovals&error=no_account')).toBe(
      '/en/sign-in?returnTo=%2Fapprovals',
    );
  });

  it('the public token pages keep their path and token (ported here)', () => {
    expect(to('/join?token=t1')).toBe('/en/join?token=t1');
    expect(to('/account/verify-email?token=t2')).toBe('/en/account/verify-email?token=t2');
    expect(to('/checkout/payment-required?ref=r1')).toBe('/en/checkout/payment-required?ref=r1');
    expect(to('/checkout?ref=r1&token=t3')).toBe('/en/checkout?ref=r1&token=t3');
  });

  it('a trailing slash (the old static export wrote them) lands the same', () => {
    expect(to('/settings/billing/')).toBe('/en/settings/billing');
  });

  it('marketing pages go to the marketing site; help to its host', () => {
    expect(to('/legal/terms-of-service')).toBe('https://gotcha.co.il/legal/terms-of-service');
    expect(to('/pricing')).toBe('https://gotcha.co.il/pricing');
    expect(to('/help/billing/refunds')).toBe('https://help.gotcha.co.il/billing/refunds');
  });
});

describe('★★ the /v2 era, and what is already ours', () => {
  it('a /v2 link loses the prefix, whatever it was (WooCommerce plugin: forever)', () => {
    expect(to('/v2/connect/woocommerce?site=a', null)).toBe('/connect/woocommerce?site=a');
    expect(to('/v2/settings/channels/website', 'he')).toBe('/he/settings/channels/website');
    expect(to('/v2/he/inbox?c=1', 'en')).toBe('/he/inbox?c=1');
    expect(to('/v2', null)).toBe('/home');
  });

  it('a path already in this app’s shape is left alone', () => {
    expect(to('/en/inbox')).toBeNull();
    expect(to('/he')).toBeNull();
    expect(to('/en')).toBeNull();
  });

  it('no locale known: unprefixed, for next-intl to negotiate', () => {
    expect(to('/conversations?id=1', null)).toBe('/inbox?c=1');
  });
});

describe('★ the locale it lands on', () => {
  const jar = (cookies: Record<string, string>) => ({
    get: (name: string) => (name in cookies ? { value: cookies[name]! } : undefined),
  });
  it("this app's cookie, else the old app's, else none; never an unknown language", () => {
    expect(legacyLocale(jar({ NEXT_LOCALE: 'he', locale: 'en' }))).toBe('he');
    expect(legacyLocale(jar({ locale: 'he' }))).toBe('he');
    expect(legacyLocale(jar({ locale: 'fr' }))).toBeNull();
    expect(legacyLocale(jar({}))).toBeNull();
  });
});
