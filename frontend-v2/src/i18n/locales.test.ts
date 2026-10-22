import { describe, expect, it } from 'vitest';

import { DEFAULT_LOCALE, LOCALES, directionOf, isLocale, localeMetadata } from './locales';

describe('locales', () => {
  it('ships English and Hebrew', () => {
    expect(LOCALES.map((locale) => locale.code)).toEqual(['en', 'he']);
  });

  it('derives direction from metadata rather than a hardcoded list', () => {
    expect(directionOf('en')).toBe('ltr');
    expect(directionOf('he')).toBe('rtl');
  });

  it('falls back to the default locale for anything unknown', () => {
    expect(localeMetadata('zz').code).toBe(DEFAULT_LOCALE);
    expect(directionOf('zz')).toBe('ltr');
  });

  it('recognises only registered locales', () => {
    expect(isLocale('he')).toBe(true);
    expect(isLocale('fr')).toBe(false);
    expect(isLocale(null)).toBe(false);
  });
});
