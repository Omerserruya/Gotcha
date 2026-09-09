/**
 * Locale registry.
 *
 * This is the whole contract for adding a language. To add, say, Arabic:
 *
 *   1. add an entry here,
 *   2. add `src/i18n/messages/ar/*.json`.
 *
 * Nothing else changes. No product component branches on a locale, and no
 * component decides its own direction - direction is read from this table and
 * applied once, on `<html dir>`, with every layout expressed in logical
 * properties so it follows automatically.
 */
export interface LocaleMetadata {
  /** BCP 47 tag. Also the URL segment. */
  readonly code: string;
  /** Writing direction. Drives `<html dir>` and Radix's DirectionProvider. */
  readonly direction: 'ltr' | 'rtl';
  /** The language's name in itself, for the language switcher. */
  readonly nativeName: string;
  /** Overrides the locale used for Intl date/number formatting, if needed. */
  readonly formattingLocale?: string;
}

export const LOCALES = [
  { code: 'en', direction: 'ltr', nativeName: 'English' },
  { code: 'he', direction: 'rtl', nativeName: 'עברית' },
] as const satisfies readonly LocaleMetadata[];

export type Locale = (typeof LOCALES)[number]['code'];

/** Used when the request names no locale, and as the message fallback. */
export const DEFAULT_LOCALE: Locale = 'en';

export const LOCALE_CODES: readonly Locale[] = LOCALES.map((locale) => locale.code);

const BY_CODE = new Map<string, LocaleMetadata>(LOCALES.map((locale) => [locale.code, locale]));

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && BY_CODE.has(value);
}

export function localeMetadata(code: string): LocaleMetadata {
  return BY_CODE.get(code) ?? BY_CODE.get(DEFAULT_LOCALE)!;
}

export function directionOf(code: string): 'ltr' | 'rtl' {
  return localeMetadata(code).direction;
}
