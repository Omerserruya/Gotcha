import { describe, expect, it } from 'vitest';

import enBilling from '@/i18n/messages/en/billing.json';
import heBilling from '@/i18n/messages/he/billing.json';
import enCapabilities from '@/i18n/messages/en/capabilities.json';
import heCapabilities from '@/i18n/messages/he/capabilities.json';
import enNavigation from '@/i18n/messages/en/navigation.json';
import heNavigation from '@/i18n/messages/he/navigation.json';

import { namesShopify } from '@/api/contracts/pricing';

/*
 * ★★ GOTCHA CORE NEVER INCLUDES SHOPIFY (Shopify review 132211).
 *
 * A sweep of every string the Billing screens can say, by key: outside the
 * Shopify Connector's own section, Shopify may be named only to say that Core
 * does NOT include it. A new string that says otherwise fails here, in either
 * language - granularity is the key, so a catalogue that renames a key is
 * caught by the allowlist going stale (its keys are checked to exist).
 */

type Tree = { readonly [key: string]: string | Tree };
function walk(tree: Tree, path = ''): [string, string][] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string'
      ? [[path ? `${path}.${key}` : key, value] as [string, string]]
      : walk(value, path ? `${path}.${key}` : key),
  );
}

/** The only Core strings that may name Shopify - each to say Core does not include it. */
const SAYS_NOT_INCLUDED = {
  'core.scope': { en: /other than Shopify/, he: /שאינם Shopify/ },
  'core.noShopify': {
    en: /does not include Shopify connection or access to Shopify data/,
    he: /לא כולל חיבור ל‑Shopify או גישה לנתונים של Shopify/,
  },
  'core.onlyCore': {
    en: /does not include the Shopify Connector/,
    he: /לא כולל את Shopify Connector/,
  },
  'pricing.change.noCard': {
    en: /The Shopify Connector is paid in Shopify and needs no card here/,
    he: /על Shopify Connector משלמים ב‑Shopify/,
  },
} as const;

const SHOPIFY = /shopify|שופיפיי/i;

describe.each([
  ['en', enBilling],
  ['he', heBilling],
] as const)('★★ Core copy, %s', (locale, billing) => {
  const strings = walk(billing as unknown as Tree);

  it('names Shopify only to say Core does not include it (the Connector section aside)', () => {
    const naming = strings
      .filter(([key, value]) => !key.startsWith('connector.') && SHOPIFY.test(value))
      .map(([key]) => key)
      .sort();
    expect(naming).toEqual(Object.keys(SAYS_NOT_INCLUDED).sort());
    for (const [key, words] of Object.entries(SAYS_NOT_INCLUDED)) {
      expect(strings.find(([k]) => k === key)?.[1]).toMatch(words[locale]);
    }
  });

  it('every Core change is "GOTCHA Core", never a generic "Change plan" / "Upgrade" / "Choose your plan"', () => {
    const generic =
      locale === 'en' ? /\bupgrade\b|choose your plan|^change plan$/i : /^שינוי תוכנית$|שדרוג/;
    expect(strings.filter(([, value]) => generic.test(value)).map(([key]) => key)).toEqual([]);
    for (const key of ['overview.changePlan', 'pricing.title']) {
      expect(strings.find(([k]) => k === key)?.[1]).toContain('GOTCHA Core');
    }
  });

  it('the Connector section never carries a price, a currency or a GOTCHA card', () => {
    const connector = strings.filter(([key]) => key.startsWith('connector.'));
    expect(connector.length).toBeGreaterThan(20);
    for (const [key, value] of connector) {
      expect([key, value]).not.toEqual([
        key,
        expect.stringMatching(/[$₪€£]|\{price\}|\{gross\}|\bcard\b|כרטיס/),
      ]);
    }
  });
});

describe.each([
  ['en', enCapabilities, enNavigation],
  ['he', heCapabilities, heNavigation],
] as const)('★★ around Core, %s', (_locale, capabilities, navigation) => {
  it('nothing says Shopify keeps billing, or that the app stays installed', () => {
    const strings = walk(capabilities as unknown as Tree);
    expect(
      strings
        .filter(([, value]) =>
          /keeps billing|stays installed|ממשיכה לחייב|נשארת מותקנת/.test(value),
        )
        .map(([key]) => key),
    ).toEqual([]);
  });

  it('the plan page is named for GOTCHA Core in the navigation', () => {
    expect(navigation.settings.billingPlan).toContain('GOTCHA Core');
  });
});

describe('★★ a Core plan card never draws a feature that names Shopify', () => {
  it.each([
    [{ nameEn: 'Shopify integration', nameHe: null }, true],
    [{ nameEn: 'Store sync', nameHe: 'סנכרון שופיפיי' }, true],
    [{ nameEn: 'One AI employee', nameHe: 'עובד AI אחד' }, false],
  ])('%o -> %s', (feature, hidden) => {
    expect(namesShopify(feature)).toBe(hidden);
  });
});
