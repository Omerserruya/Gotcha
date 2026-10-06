/**
 * A sentence's values, each in its own direction — the text form of `<bdi>`.
 *
 * Measured on dev in Hebrew: "הוחזרו 50 לMatan Amran" read "Matan Amranל 50
 * הוחזר", and "#TEST-1842" lost its "#" to the far end. The values are a
 * customer's name, an order number, a server's summary — not ours — and in a
 * catalogue sentence they cannot be wrapped in an element, so each is wrapped
 * in FIRST STRONG ISOLATE … POP DIRECTIONAL ISOLATE (U+2068 … U+2069): the
 * same isolation, as characters.
 *
 * `none` is left bare: it is an ICU `select` sentinel, not text.
 */
const FSI = '⁨';
const PDI = '⁩';

export function isolated<T extends Record<string, string>>(values: T): T {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      value === 'none' || value === '' ? value : `${FSI}${value}${PDI}`,
    ]),
  ) as T;
}
