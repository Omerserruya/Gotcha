import { describe, expect, it } from 'vitest';

import { zoneFromInput, zoneLabel, zoneOptions } from './zones';

const AT = new Date('2026-10-08T12:00:00Z');

describe('★ a time zone in the reader’s words', () => {
  it('Hebrew: Intl’s Hebrew name and offset; English: 02’s city and offset', () => {
    expect(zoneLabel('Europe/London', 'he', AT)).toMatch(/^שעון בריטניה \(GMT/);
    expect(zoneLabel('Asia/Jerusalem', 'he', AT)).toMatch(/^שעון ישראל \(GMT/);
    expect(zoneLabel('Europe/London', 'en', AT)).toBe('London (GMT+1)');
  });

  it('★ zones sharing a Hebrew name carry their city, so each option is one zone - and resolves', () => {
    const options = zoneOptions('he', AT);
    const paris = options.find((z) => z.iana === 'Europe/Paris')!;
    const berlin = options.find((z) => z.iana === 'Europe/Berlin')!;
    expect(paris.label).not.toBe(berlin.label);
    expect(paris.label).toContain('Paris');
    expect(new Set(options.map((z) => z.label)).size).toBe(options.length);
    expect(zoneFromInput(paris.label, options)).toBe('Europe/Paris');
  });
});
