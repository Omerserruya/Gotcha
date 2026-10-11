import { describe, expect, it } from 'vitest';

import { countryName, countryOptions, displayHost, websiteOrigin } from './workspace';

describe('★ a website as 02 writes it - the host alone', () => {
  it('drops the scheme, `www.` and the path', () => {
    expect(displayHost('https://urban-supply-gotcha-demo.myshopify.com')).toBe(
      'urban-supply-gotcha-demo.myshopify.com',
    );
    expect(displayHost('https://www.avivco.il/shop/')).toBe('avivco.il');
    expect(displayHost('avivco.il')).toBe('avivco.il');
    expect(displayHost('  http://www.avivco.il  ')).toBe('avivco.il');
  });
});

describe('websiteOrigin: what auth normalizeWebsite stores (a6bfa7c9)', () => {
  it.each([
    ['shop.example.com', 'https://shop.example.com'],
    ['  HTTP://Shop.Example.com/about?x=1  ', 'http://shop.example.com'],
    ['https://example.co.il:8443/', 'https://example.co.il:8443'],
  ])('%j → %j', (raw, origin) => expect(websiteOrigin(raw)).toBe(origin));

  it.each([
    '',
    'our shop',
    'ftp://example.com',
    'https://me:pw@example.com',
    'localhost',
    'https://1.2.3.4',
  ])('%j → null, which the route refuses', (raw) => expect(websiteOrigin(raw)).toBeNull());
});

describe('a stored country: a name for an assigned ISO code, nothing for anything else', () => {
  it('a code by its name, in the screen’s language', () => {
    expect(countryName('il', 'en')).toBe('Israel');
    expect(countryName('IL', 'he')).toBe('ישראל');
  });

  it.each(['unknown', 'Israel', 'I L', 'ZZ', 'EU', 'XA', 'SU', '', null, undefined])(
    '%j → null',
    (v) => expect(countryName(v, 'en')).toBeNull(),
  );

  it('the list: each country once, by name, in order; no grouping, alias or private code', () => {
    const list = countryOptions('en');
    const codes = list.map((c) => c.code);
    expect(codes).toContain('IL');
    expect(codes).toContain('XK');
    for (const not of ['EU', 'UN', 'ZZ', 'QO', 'XA', 'UK', 'SU', 'YU', 'AC', 'IC']) {
      expect(codes).not.toContain(not);
    }
    expect(new Set(list.map((c) => c.name)).size).toBe(list.length);
    expect(list.map((c) => c.name)).toEqual(
      [...list.map((c) => c.name)].sort((a, b) => a.localeCompare(b, 'en')),
    );
    expect(list.length).toBeGreaterThan(240);
  });
});
