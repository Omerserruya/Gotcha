/**
 * Matching against the platform's permission strings.
 *
 * ── The rule is EXACT MATCH ────────────────────────────────────────────────
 * Confirmed against `services/auth/src/routes/permissions.ts`:
 *
 *   - the format is always `domain:resource:action` — three parts, never two,
 *     never four;
 *   - there are **no wildcards** in a granted set;
 *   - there is **no implication**: holding `conversation:messages` grants
 *     nothing at all. `conversation:messages:read` is a different key.
 *
 * An earlier version of this file implemented prefix implication and wildcard
 * matching, inferred from the phrase "hierarchical" in the API documentation.
 * That was wrong, and wrong in the dangerous direction: it would have shown
 * controls to people who cannot use them, and every failure would have
 * surfaced as a 403 after the click instead of a disabled control before it.
 *
 * The one exception is real and is the backend's own: `SYSTEM_ADMIN`
 * short-circuits to every key (`permissions.ts:457`).
 * ──────────────────────────────────────────────────────────────────────────
 */
export type PermissionString = string;

/** The backend role that bypasses the permission set entirely. */
export const SYSTEM_ADMIN_ROLE = 'SYSTEM_ADMIN';

export class PermissionSet {
  private readonly held: ReadonlySet<string>;
  private readonly isSystemAdmin: boolean;

  constructor(permissions: readonly PermissionString[], roleKey?: string) {
    this.held = new Set(permissions);
    this.isSystemAdmin = roleKey === SYSTEM_ADMIN_ROLE;
  }

  /** True when the set grants `required`. Exact match, or system admin. */
  has(required: PermissionString): boolean {
    return this.isSystemAdmin || this.held.has(required);
  }

  hasAll(required: readonly PermissionString[]): boolean {
    return required.every((permission) => this.has(permission));
  }

  hasAny(required: readonly PermissionString[]): boolean {
    return required.some((permission) => this.has(permission));
  }

  get size(): number {
    return this.held.size;
  }
}

/** An empty set: used before permissions load, and after sign-out. */
export const EMPTY_PERMISSIONS = new PermissionSet([]);
