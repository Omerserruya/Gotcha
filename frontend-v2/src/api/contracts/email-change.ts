import { z } from 'zod';

/**
 * Confirming a new sign-in address - the `/account/verify-email?token=` link
 * mailed to the NEW address (services/auth account.ts:433 builds it).
 *
 * `POST /api/account/email-change/verify` `{ token }` (account.ts:448), behind
 * `authenticate` (:41): the signed-in person must be the one the token was
 * issued for. `{ ok: true, email }` - no envelope. Refusals, as `error`:
 *
 *   400 invalid_or_expired   the signed token does not verify, or has expired
 *   403 wrong_account        signed in as somebody else
 *   404 not_found            the account is gone
 *   409 email_taken          somebody took the address in the meantime
 *   502 idp_sync_failed      Authentik refused; GOTCHA rolled back, retryable
 *
 * ★ Repeating it is harmless: a second confirm of an address that is already
 *   the account's own passes every check and writes the same value.
 */
export const emailChangeVerifiedSchema = z.object({
  email: z.string(),
});

export const EMAIL_CHANGE_REFUSALS = {
  invalid: 'invalid_or_expired',
  wrongAccount: 'wrong_account',
  taken: 'email_taken',
  idp: 'idp_sync_failed',
} as const;
