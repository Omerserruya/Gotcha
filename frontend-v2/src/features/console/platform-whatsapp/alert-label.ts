/**
 * An alert's name on screen, by its Meta template name (fixed in code,
 * `platform-templates.ts`). A name this build has no words for is shown as
 * the template's own name, never as nothing.
 */
export function alertLabel(
  t: { has: (key: string) => boolean; (key: string): string },
  name: string,
): string {
  const key = `event.${name}`;
  return t.has(key) ? t(key) : name;
}
