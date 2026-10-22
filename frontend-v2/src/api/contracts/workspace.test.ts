import { describe, expect, it } from 'vitest';

import {
  countryName,
  countryOptions,
  displayHost,
  scanRunSchema,
  scanStateSchema,
  websiteOrigin,
} from './workspace';

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

describe('★★ the rescan as a run (auth 8d01252f)', () => {
  it('a done run keeps what it applied, offered, saw and did to the pages', () => {
    const run = scanRunSchema.parse({
      status: 'done',
      startedAt: '2026-10-14T10:00:00Z',
      finishedAt: '2026-10-14T10:00:26Z',
      reason: null,
      applied: ['industry'],
      offer: [
        { field: 'organizationName', current: 'A', proposed: 'B', because: 'source_unknown' },
      ],
      reach: { requested: 12, pagesRead: 11, distinctTextPages: 9 },
      knowledge: { created: 1, updated: 2, unchanged: 3, preserved: 1, removed: 0, failed: 0 },
    });
    expect(run.applied).toEqual(['industry']);
    expect(run.offer).toHaveLength(1);
    expect(run.knowledge).toEqual({
      created: 1,
      updated: 2,
      unchanged: 3,
      preserved: 1,
      removed: 0,
      failed: 0,
    });
  });

  it('★ an offer that does not parse is left out alone - never the run, never the others', () => {
    const run = scanRunSchema.parse({
      status: 'done',
      offer: [
        { field: 'a', current: 1, proposed: 2, because: 'a_new_reason' },
        { field: 'b', current: 1, proposed: 2, because: 'human_edited' },
      ],
    });
    expect(run.offer.map((o) => o.field)).toEqual(['b']);
  });

  it('a running run from the start: nothing yet, and no pages counted', () => {
    expect(scanRunSchema.parse({ status: 'running' })).toMatchObject({
      applied: [],
      offer: [],
      reach: null,
      knowledge: null,
    });
  });

  it('the state: the last run, or null when none ever started', () => {
    expect(scanStateSchema.parse({ run: null, fieldSources: {} }).run).toBeNull();
    expect(
      scanStateSchema.parse({ run: { status: 'failed', reason: 'timed_out' } }).run?.reason,
    ).toBe('timed_out');
  });
});
