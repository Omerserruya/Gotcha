/**
 * A phone, an email or a channel handle, inside text that may be Hebrew.
 *
 * Digits are weak in the bidi algorithm: in a right-to-left line
 * "+972 54 568 0665" lays out as "0665 568 54 972+" (measured on dev, 04b).
 * LRI…PDI makes the value one left-to-right island wherever it lands - a
 * joined line, a title, a sentence - which a `<bdi dir="ltr">` cannot do
 * inside a string. The test matcher ignores the isolates (src/test/setup.ts).
 */
const LRI = String.fromCharCode(0x2066);
const PDI = String.fromCharCode(0x2069);

export function ltr(value: string): string;
export function ltr(value: string | null | undefined): string | null;
export function ltr(value: string | null | undefined): string | null {
  return value ? `${LRI}${value}${PDI}` : null;
}
