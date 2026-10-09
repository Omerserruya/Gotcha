/**
 * Onboarding as a preview (`?preview=1`, Omer, 2026-10-07): a live
 * workspace's admin walks the screens read-only. Every step link keeps the
 * flag, or the next screen would be the gated one and send them Home.
 */
export function isPreview(params: { readonly preview?: string } | undefined): boolean {
  return params?.preview === '1';
}

type StepPath = `/onboarding${string}`;

/** A step's href, carrying `preview=1` when previewing. */
export function stepHref(
  pathname: StepPath,
  preview: boolean,
  query: Readonly<Record<string, string>> = {},
): StepPath | { pathname: StepPath; query: Record<string, string> } {
  const all = preview ? { ...query, preview: '1' } : { ...query };
  return Object.keys(all).length === 0 ? pathname : { pathname, query: all };
}
