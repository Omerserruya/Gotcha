import { z } from 'zod';

/**
 * Public account deletion (Google Play's Data safety requires a web page for
 * it; Omer, 2026-11-14). Two calls, both without a session, behind
 * `/account-deletion` and `/account-deletion/confirm` (`SIGNED_OUT_ROUTES`).
 *
 * Agreed with Backend-Team on 2026-11-14 (release-next-kit/account-deletion/
 * CONTRACT.md), under the auth service's `/api/auth` prefix. Nothing is deleted
 * automatically: an operator completes each request by `deleteBy`.
 *
 * ★ An answer this screen does not understand is "it did not go through",
 *   never a success.
 */

/** The refusals the request answers, each its own sentence on screen. */
export const REQUEST_REFUSALS = ['BAD_EMAIL', 'RATE_LIMITED'] as const;
export type RequestRefusal = (typeof REQUEST_REFUSALS)[number];

/** The refusals the confirm answers, each its own sentence on screen. */
export const CONFIRM_REFUSALS = ['BAD_TOKEN', 'TOKEN_EXPIRED', 'ALREADY_CONFIRMED'] as const;
export type ConfirmRefusal = (typeof CONFIRM_REFUSALS)[number];

/** The longest workspace name sent; the route keeps at most this many. */
export const MAX_WORKSPACE = 120;

/** How long the emailed link works (Backend): single use. */
export const LINK_HOURS = 24;

/**
 * `POST /api/auth/account-deletion/request` → 202 `{ data: { accepted: true } }`,
 * for ANY well-formed address: whether an account exists is never said, so
 * the page cannot be used to learn who is a customer.
 */
export const deletionRequestedSchema = z.object({
  data: z.object({ accepted: z.literal(true) }),
});

const when = z
  .string()
  .nullable()
  .catch(null)
  .default(null)
  .transform((v) => (v && !Number.isNaN(Date.parse(v)) ? v : null));

/**
 * `POST /api/auth/account-deletion/confirm {token}` → 200: the request is
 * confirmed. `deleteBy`: the DEADLINE an operator completes it by (the
 * confirmation plus 30 days) (said as "by <date>", never "after" or "on").
 * `email`: masked by the server (`d***@aviv.co.il`), or `null`.
 */
export const deletionConfirmedSchema = z.object({
  data: z.object({
    status: z.literal('scheduled'),
    deleteBy: when,
    email: z.string().nullable().catch(null).default(null),
  }),
});
export type DeletionConfirmed = z.infer<typeof deletionConfirmedSchema>['data'];

/** A typed address worth sending: one @, something on each side, a dot after it. */
export function isEmailLike(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}
