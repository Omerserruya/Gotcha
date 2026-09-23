import { z } from 'zod';

/**
 * The permission catalogue — screen 12c.
 *
 * `GET /api/permissions/catalog` → `{ data: { permissions, byDomain,
 * builtinRoles, scopes } }`. Sixty-three permissions, twenty-nine of which
 * carry the scope dimension.
 *
 * ── WHY THIS IS A CATALOGUE AND NOT THE DESIGN'S GRID ──
 * The design draws one row per area with **None / View / Edit / Manage** and
 * a scope and a money limit per row. The model is:
 * ```
 * conversation:messages:read · reply · takeover · assign · close
 * ```
 * **The action IS the level, and each action is an independent key.** There is
 * no single "conversations" permission with four settings — there are five
 * separate booleans, and *"Edit"* maps to none of them.
 *
 * **A four-level radio over independent keys is not a lossy display. It is a
 * lossy WRITE.** Someone opens a role to change one thing, the grid renders
 * the nearest approximation of five booleans as one of four levels, they
 * save, and **a permission they never looked at is gone** — no error, no
 * warning, and the role now differs from what its owner believes.
 *
 * > **A control that cannot represent a state the system can be in will
 * > eventually be used to destroy that state.**
 *
 * So each permission appears as itself, and `roundTrips` below is the
 * property that justifies the choice: open a role, change nothing, save, and
 * get back exactly what you had.
 *
 * ── SCOPE IS PER ROLE, NOT PER ROW ──
 * `SCOPE_ORDER` is `own · team · department · workspace` and the value lives
 * on the role. `PermissionDef.scoped` is a **boolean — whether the dimension
 * applies at all** — so a permission with `scoped: false` must not be shown
 * taking a scope. A greyed scope control on a row that has none is the same
 * lie in miniature.
 */

export const SCOPES = ['own', 'team', 'department', 'workspace'] as const;
export type Scope = (typeof SCOPES)[number];

export const permissionDefSchema = z.object({
  /** `domain:feature:action` — the action is the level. */
  key: z.string().min(1),
  domain: z.string().default(''),
  feature: z.string().default(''),
  subFeature: z.string().default(''),
  action: z.string().default(''),
  /** **Whether the scope dimension applies**, not what it is set to. */
  scoped: z.boolean().default(false),
  displayName: z.string().default(''),
  description: z.string().default(''),
});

export type PermissionDef = z.infer<typeof permissionDefSchema>;

export const catalogSchema = z
  .object({
    data: z.object({
      permissions: z.array(permissionDefSchema).default([]),
      scopes: z.array(z.string()).default([]),
    }),
  })
  .transform(({ data }) => ({
    permissions: data.permissions,
    scopes: data.scopes.filter((s): s is Scope => (SCOPES as readonly string[]).includes(s)),
  }));

export interface PermissionDomain {
  readonly domain: string;
  readonly permissions: readonly PermissionDef[];
}

/**
 * Grouped by domain, in the catalogue's own order.
 *
 * The route already provides `byDomain`; this regroups from `permissions` so
 * the order is the catalogue's rather than an object's key order, which is
 * not guaranteed to survive JSON.
 */
export function groupByDomain(permissions: readonly PermissionDef[]): readonly PermissionDomain[] {
  const groups = new Map<string, PermissionDef[]>();
  for (const permission of permissions) {
    const existing = groups.get(permission.domain);
    if (existing) existing.push(permission);
    else groups.set(permission.domain, [permission]);
  }
  return [...groups.entries()].map(([domain, items]) => ({ domain, permissions: items }));
}

/**
 * Does editing a role and saving it unchanged give back what it had?
 *
 * **This is the property the design's grid could not offer**, and it is the
 * reason this screen is a catalogue. A control that can only represent four
 * levels over five independent keys must pick one when it saves, and the
 * permissions it cannot express are lost silently.
 *
 * Here the answer is trivially yes, and the test exists to keep it that way:
 * a selection is the set of keys themselves, so saving an untouched role is
 * the identity function.
 */
export function roundTrips(original: readonly string[], saved: readonly string[]): boolean {
  if (original.length !== saved.length) return false;
  const a = [...original].sort();
  const b = [...saved].sort();
  return a.every((key, i) => key === b[i]);
}

/**
 * The keys a role would save, given what is ticked.
 *
 * Deliberately the identity of the selection rather than anything derived:
 * every transformation between what is shown and what is written is a place
 * a permission can be lost.
 */
export function selectionToFeatures(selected: readonly string[]): readonly string[] {
  return [...selected];
}

/** Only a permission that declares the dimension may be shown taking a scope. */
export function takesScope(permission: PermissionDef): boolean {
  return permission.scoped;
}
