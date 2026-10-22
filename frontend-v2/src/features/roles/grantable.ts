import { isMergedAdmin, type Role } from '@/api/contracts/roles';

/**
 * The roles someone may give - the invite's role list (auth 679b8812).
 *
 * The server's rule, read back so the list offers only what it will take:
 * a role is given only by someone who holds every permission it expands to
 * ("*" and "area:resource:*" against the catalogue), and the Owner role by an
 * Owner only. An Owner (or a platform admin) may give any role.
 *
 * Where this side cannot know, it offers rather than hides, and the server
 * says no in a sentence: a pattern with no catalogue to expand it against,
 * and a permission set that could not be read (`has` then answers true, as
 * `canSee` does). The Owner role is the exception - it is offered only to a
 * viewer KNOWN to be an Owner, because "unknown" is not an Owner.
 *
 * The merged Admin role is offered to nobody, an Owner included: Admin is part
 * of Owner now, and giving it answers 409 ROLE_MERGED (auth 30d610da). The
 * list returns it only while someone still holds it.
 */
export interface Viewer {
  /** Exact-match permission check - `usePermissions().canSee`. */
  readonly has: (permission: string) => boolean;
  /** `/permissions/me`'s `roleKey`: "owner", "system_admin", …; absent when unread. */
  readonly roleKey?: string | null;
}

export function isOwnerViewer(viewer: Viewer): boolean {
  const key = viewer.roleKey?.toLowerCase();
  return key === 'owner' || key === 'system_admin';
}

const isOwnerRole = (role: Role) => role.builtinKey?.toLowerCase() === 'owner';

export function grantableRoles(
  roles: readonly Role[],
  viewer: Viewer,
  /** Every key the catalogue lists; `null` when it was not read. */
  catalog: readonly string[] | null,
): readonly Role[] {
  const offered = roles.filter((role) => !isMergedAdmin(role));
  if (isOwnerViewer(viewer)) return offered;
  return offered.filter(
    (role) =>
      !isOwnerRole(role) &&
      role.features.every((pattern) => {
        const keys = expand(pattern, catalog);
        return keys === null || keys.every((key) => viewer.has(key));
      }),
  );
}

/** A pattern's keys; `null` when it needs a catalogue that was not read. */
function expand(pattern: string, catalog: readonly string[] | null): readonly string[] | null {
  if (pattern === '*') return catalog;
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -1);
    return catalog === null ? null : catalog.filter((key) => key.startsWith(prefix));
  }
  return [pattern];
}
