import { isApiError } from '@/api/client/api-error';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * NOBODY GIVES WHAT THEY DO NOT HOLD (auth 679b8812, `lib/grant-ceiling`)
 * ════════════════════════════════════════════════════════════════════════════
 * Creating or editing a role, granting or removing a permission, giving or
 * replacing someone's role, and inviting into a role are all refused the same
 * two ways, with a 403:
 *
 *   ABOVE_OWN_ROLE  `{ code, missing: [keys] }` - the set expands to keys the
 *                   caller does not hold ("*" and "area:*" against the
 *                   catalogue), so a non-owner can never hand out a wildcard.
 *   OWNER_ONLY      `{ code }` - the Owner role is given, and an Owner's
 *                   access changed, by an Owner only.
 *
 * One reading for every write that can meet them, so each screen says the
 * same sentence (`ceilingSentence`). Nothing was written on either refusal.
 */
export type CeilingRefusal =
  | { readonly ok: false; readonly reason: 'above_own_role'; readonly missing: readonly string[] }
  | { readonly ok: false; readonly reason: 'owner_only' };

/** The refusal in `cause`, or `null` when it is some other failure. */
export function ceilingRefusalOf(cause: unknown): CeilingRefusal | null {
  if (!isApiError(cause)) return null;
  if (cause.code === 'ABOVE_OWN_ROLE') {
    return { ok: false, reason: 'above_own_role', missing: [...(cause.missing ?? [])] };
  }
  if (cause.code === 'OWNER_ONLY') return { ok: false, reason: 'owner_only' };
  return null;
}
