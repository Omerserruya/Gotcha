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
  const names = namesOf(refusal.missing, t);
  return names ? t('ceiling.aboveOwn', { permissions: list(names) }) : t('ceiling.aboveOwnUnnamed');
}

type Words = {
  (key: string, values?: Record<string, string>): string;
  has: (key: string) => boolean;
};

/** Every key in the grid's words, once each - or `null` when one has none. */
function namesOf(keys: readonly string[], t: Words): readonly string[] | null {
  const names = keys.map((key) => nameOf(key, t));
  return names.length > 0 && names.every((name): name is string => name !== null)
    ? [...new Set(names)]
    : null;
}

/**
 * A built-in role's own rules, refused on save (auth 30d610da) - the same
 * naming as the grant ceiling: the grid's words for every key, or none.
 *
 *   role_ceiling  the keys this role can never hold (`blocked`)
 *   owner_floor   the keys the Owner always keeps (`missing`)
 *   role_merged   the Admin role, now part of Owner
 */
export type RoleRuleReason =
  | { readonly reason: 'role_ceiling'; readonly blocked: readonly string[] }
  | { readonly reason: 'owner_floor'; readonly missing: readonly string[] }
  | { readonly reason: 'role_merged' };

export function roleRuleSentence(
  refusal: RoleRuleReason,
  t: Words,
  list: (items: readonly string[]) => string,
): string {
  if (refusal.reason === 'role_merged') return t('rules.refused.merged');
  if (refusal.reason === 'role_ceiling') {
    const names = namesOf(refusal.blocked, t);
    return names
      ? t('rules.refused.ceiling', { permissions: list(names) })
      : t('rules.refused.ceilingUnnamed');
  }
  const names = namesOf(refusal.missing, t);
  return names
    ? t('rules.refused.floor', { permissions: list(names) })
    : t('rules.refused.floorUnnamed');
}

/** True for the three refusals `roleRuleSentence` says. */
export function isRoleRuleReason(result: { readonly reason: string }): result is RoleRuleReason {
  return (
    result.reason === 'role_ceiling' ||
    result.reason === 'owner_floor' ||
    result.reason === 'role_merged'
  );
}

/** `roleRuleSentence` in the reader's language, for a client component. */
export function useRoleRuleSentence(): (refusal: RoleRuleReason) => string {
  const t = useTranslations('roles');
  const format = useFormatter();
  return (refusal) =>
    roleRuleSentence(refusal, t as unknown as Words, (items) =>
      format.list(items, { type: 'conjunction' }),
    );
}

function nameOf(key: string, t: Words): string | null {
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
