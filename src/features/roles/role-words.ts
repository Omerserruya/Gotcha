/**
 * A role in the reader's words.
 *
 * The four built-in roles arrive with the platform's English name and
 * description (permission-catalog.ts in ChatCenter), so a Hebrew screen
 * showed "Admin" and "Full operational and configuration access…". They are
 * said from the catalogue by `builtinKey` - never by matching the name, which
 * would translate a custom role somebody happened to call "Admin". A role the
 * workspace made keeps the words its owner typed: translating them is not
 * ours to do.
 *
 * A built-in role cannot be renamed or rewritten (403 SYSTEM_ROLE), so the
 * catalogue cannot drift from what the role is.
 */
export const BUILTIN_ROLE_KEYS = ['owner', 'admin', 'department_manager', 'agent'] as const;
export type BuiltinRoleKey = (typeof BUILTIN_ROLE_KEYS)[number];

export function builtinRoleKey(key: string | null | undefined): BuiltinRoleKey | null {
  return (BUILTIN_ROLE_KEYS as readonly string[]).includes(key ?? '')
    ? (key as BuiltinRoleKey)
    : null;
}

/** The catalogue's words for a built-in role - `roles.builtinRole.<key>.<part>`. */
export type BuiltinWords = (key: BuiltinRoleKey, part: 'name' | 'description') => string;

export function roleNameOf(
  role: { readonly name: string; readonly builtinKey?: string | null },
  words: BuiltinWords,
): string {
  const key = builtinRoleKey(role.builtinKey);
  return key ? words(key, 'name') : role.name;
}

export function roleDescriptionOf(
  role: { readonly description?: string | null; readonly builtinKey?: string | null },
  words: BuiltinWords,
): string | null {
  const key = builtinRoleKey(role.builtinKey);
  return key ? words(key, 'description') : (role.description ?? null);
}
