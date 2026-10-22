import { describe, expect, it } from 'vitest';

import { zoneFromInput, zoneGroups, zoneLabel, zoneOffsetMinutes, zoneOptions } from './zones';

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

describe('★★ the picker’s order: common first, then by offset (Omer, 2026-10-11)', () => {
  const at = new Date('2026-01-15T12:00:00Z');
  it('reads the offset in minutes, half hours and west included', () => {
    expect(zoneOffsetMinutes('UTC', at)).toBe(0);
    expect(zoneOffsetMinutes('Asia/Jerusalem', at)).toBe(120);
    expect(zoneOffsetMinutes('Asia/Kolkata', at)).toBe(330);
    expect(zoneOffsetMinutes('America/New_York', at)).toBe(-300);
  });

  it('the rest run west to east, then by what they say', () => {
    const { rest } = zoneGroups(zoneOptions('en', at), null, 'en', at);
    const offsets = rest.map((z) => zoneOffsetMinutes(z.iana, at));
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  });

  it('in Hebrew, the common group opens on Israel’s own name', () => {
    const { common } = zoneGroups(zoneOptions('he', at), null, 'he', at);
    expect(common[0]?.iana).toBe('Asia/Jerusalem');
    expect(common[0]?.label).toMatch(/^שעון ישראל/);
  });

  it('a stored zone is second, and never twice', () => {
    const { common } = zoneGroups(zoneOptions('en', at), 'Europe/London', 'en', at);
    expect(common.map((z) => z.iana)).toEqual([
      'Asia/Jerusalem',
      'Europe/London',
      'America/New_York',
      'Europe/Paris',
      'UTC',
    ]);
  });
});
