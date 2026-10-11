import { useFormatter, useTranslations } from 'next-intl';

/**
 * The sentence for a grant-ceiling refusal (`ceiling.ts`), the same on every
 * screen that can meet one: Roles' form, the person panel's grants and role,
 * and the invite.
 *
 * ABOVE_OWN_ROLE names what is missing **in the role grid's own words** -
 * `form.row.<feature:sub-feature>` and `form.action.<action>`, joined by
 * `catalog.permissionName` - and only when the grid has words for every key.
 * One unnamed key and the sentence names none: a list of codes, or a list
 * that silently leaves one out, would both mislead.
 *
 * Plain module (no directive): called from client components only.
 */
export type CeilingReason =
  | { readonly reason: 'above_own_role'; readonly missing: readonly string[] }
  | { readonly reason: 'owner_only' };

/** `t` is a `roles` translator; `list` joins the names in the reader's language. */
export function ceilingSentence(
  refusal: CeilingReason,
  t: {
    (key: string, values?: Record<string, string>): string;
    has: (key: string) => boolean;
  },
  list: (items: readonly string[]) => string,
): string {
  if (refusal.reason === 'owner_only') return t('ceiling.ownerOnly');
  const names = refusal.missing.map((key) => nameOf(key, t));
  return names.length > 0 && names.every((name): name is string => name !== null)
    ? t('ceiling.aboveOwn', { permissions: list([...new Set(names)]) })
    : t('ceiling.aboveOwnUnnamed');
}

function nameOf(
  key: string,
  t: { (key: string, values?: Record<string, string>): string; has: (key: string) => boolean },
): string | null {
  const parts = key.split(':');
  if (parts.length !== 3 || parts.some((part) => part === '' || part === '*')) return null;
  const [feature, subFeature, action] = parts as [string, string, string];
  const rowKey = `form.row.${feature}:${subFeature}`;
  const actionKey = `form.action.${action}`;
  if (!t.has(rowKey) || !t.has(actionKey)) return null;
  return t('catalog.permissionName', { row: t(rowKey), action: t(actionKey) });
}

/** True for the two refusals `ceilingSentence` says. */
export function isCeilingReason(result: { readonly reason: string }): result is CeilingReason {
  return result.reason === 'above_own_role' || result.reason === 'owner_only';
}

/** `ceilingSentence` in the reader's language, for a client component. */
export function useCeilingSentence(): (refusal: CeilingReason) => string {
  const t = useTranslations('roles');
  const format = useFormatter();
  return (refusal) =>
    ceilingSentence(refusal, t as unknown as Parameters<typeof ceilingSentence>[1], (items) =>
      format.list(items, { type: 'conjunction' }),
    );
}
