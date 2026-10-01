/**
 * Up to two initials for the avatar, from whatever the name turns out to be.
 *
 * ⚠⚠ `customerName` IS NOT A PERSON'S NAME HERE. A Shopify live-chat row
 *    reads "Shopper on urban-supply-gotcha-demo.myshopify.com" — a
 *    forty-character unbroken token. Taking the first letter of the first two
 *    WORDS gives "SO", which is meaningless but harmless; taking a slice of
 *    the raw string would put a fragment of a shop domain in a circle.
 *
 * ★ Empty for an unnamed row rather than a placeholder glyph: the circle is
 *   decorative, `aria-hidden`, and the name beside it already says "Someone".
 */
export function initials(name: string | null): string {
  if (name === null) return '';
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
}
