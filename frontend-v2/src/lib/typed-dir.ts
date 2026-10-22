/**
 * The direction of a field the person types into.
 *
 * `dir="auto"` reads the direction from the VALUE - right for what is typed,
 * wrong for the placeholder, which is the interface's words: an empty field
 * resolves to left to right, and a Hebrew placeholder with an English word
 * in it ("…לומר ל־GOTCHA מה לעשות") comes out in the wrong order (dev,
 * 2026-10-07). Empty, the field takes the page's direction; typed into, the
 * text's own.
 */
export function typedDir(value: string): 'auto' | undefined {
  return value === '' ? undefined : 'auto';
}
