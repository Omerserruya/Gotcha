import { z } from 'zod';

/**
 * How a value is written into a query string and read back.
 *
 * A codec, rather than `String(value)` at each call site, because the two
 * directions must agree exactly. When they drift, a filter silently stops
 * matching after a page refresh and nobody can reproduce it.
 *
 * `decode` is total: it is handed whatever is in the URL, which a user may
 * have typed, truncated, or shared from an older version of the app. It
 * returns the default rather than throwing - a malformed URL should degrade to
 * a sensible view, never to an error page.
 */
export interface UrlCodec<T> {
  readonly encode: (value: T) => string | null;
  readonly decode: (raw: string | null) => T;
  readonly defaultValue: T;
}

/**
 * Values equal to the default encode to `null` and are dropped from the URL.
 *
 * This keeps a shared link short and meaningful: `?status=open` says something,
 * `?status=all&page=1&sort=recent&view=list` says the user opened a page.
 */
function omitDefault<T>(value: T, defaultValue: T, encode: (value: T) => string): string | null {
  return Object.is(value, defaultValue) ? null : encode(value);
}

export function stringParam(defaultValue = ''): UrlCodec<string> {
  return {
    defaultValue,
    encode: (value) => omitDefault(value, defaultValue, (v) => v),
    decode: (raw) => raw ?? defaultValue,
  };
}

export function numberParam(defaultValue: number): UrlCodec<number> {
  return {
    defaultValue,
    encode: (value) => omitDefault(value, defaultValue, String),
    decode: (raw) => {
      if (raw === null) return defaultValue;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : defaultValue;
    },
  };
}

export function booleanParam(defaultValue = false): UrlCodec<boolean> {
  return {
    defaultValue,
    encode: (value) => omitDefault(value, defaultValue, (v) => (v ? '1' : '0')),
    decode: (raw) => (raw === null ? defaultValue : raw === '1' || raw === 'true'),
  };
}

/**
 * A value constrained to a known set.
 *
 * Anything else in the URL falls back to the default, so a stale or
 * hand-edited link cannot push an unexpected value into the application.
 */
export function enumParam<const T extends readonly string[]>(
  allowed: T,
  defaultValue: T[number],
): UrlCodec<T[number]> {
  return {
    defaultValue,
    encode: (value) => omitDefault(value, defaultValue, (v) => v),
    decode: (raw) => (raw !== null && allowed.includes(raw) ? raw : defaultValue),
  };
}

/** A comma-separated set, for multi-select filters. Order is not significant. */
export function stringSetParam(defaultValue: readonly string[] = []): UrlCodec<readonly string[]> {
  return {
    defaultValue,
    encode: (value) => (value.length === 0 ? null : [...value].sort().join(',')),
    decode: (raw) => (raw === null || raw === '' ? defaultValue : raw.split(',').filter(Boolean)),
  };
}

/**
 * An ISO date, for range filters.
 *
 * Stored as `YYYY-MM-DD` rather than a timestamp so a shared link means the
 * same day to a colleague in another timezone.
 */
export function isoDateParam(defaultValue: string | null = null): UrlCodec<string | null> {
  const schema = z.iso.date();
  return {
    defaultValue,
    encode: (value) => (value === null ? null : value),
    decode: (raw) => (raw !== null && schema.safeParse(raw).success ? raw : defaultValue),
  };
}
