'use server';

import { revalidatePath } from 'next/cache';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import {
  revokeResultSchema,
  tenantSecuritySchema,
  type TenantSecurity,
} from '@/api/contracts/security';
import { securityEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';
import { signInIfSignedOut } from '@/api/client/signed-out';

/**
 * Writes for screen 16.
 *
 * Revoking a session is destructive in the way that matters here — it signs
 * somebody out — but it is the ONE destructive action on this project that is
 * meant to be pressed: it is the whole point of showing the list. It is also
 * recoverable in the only sense that counts, since the person can sign in
 * again.
 *
 * **Nothing here logs an IP, a city or a user agent.** A failure carries a
 * status and a route; the session's details are the reader's own and belong on
 * their screen, not in telemetry.
 */

export type SecurityWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'forbidden' }
  /** The IdP could not be reached. Distinct from "it refused". */
  | { readonly ok: false; readonly reason: 'unavailable' }
  /**
   * ★ WE COULD NOT CONFIRM IT, WHICH IS NOT "IT DID NOT HAPPEN".
   *
   * The route answered without a usable `ok`. The session may well be gone.
   * "That didn't sign out" would be a claim we cannot make, and the safe
   * advice is the same either way: **signing out again is idempotent**, so
   * the screen says what it knows and offers the control back.
   */
  | { readonly ok: false; readonly reason: 'unconfirmed' }
  | { readonly ok: false; readonly reason: 'failed' };

function classify(cause: unknown): Extract<SecurityWriteResult, { ok: false }> {
  if (isApiError(cause)) {
    if (cause.kind === 'authorization') return { ok: false, reason: 'forbidden' };
    // The account routes answer 502 `idp_unavailable` when Authentik is down,
    // which is worth telling apart: nothing was revoked and trying again later
    // is the right advice.
    if (cause.kind === 'integration') return { ok: false, reason: 'unavailable' };
  }
  return { ok: false, reason: 'failed' };
}

/** Signs one session out. The reader's own stays untouched. */
export async function revokeSession(id: string): Promise<SecurityWriteResult> {
  try {
    const result = await serverApi().delete({
      endpoint: securityEndpoints.revokeSession(id),
      payload: revokeResultSchema,
      raw: true,
    });
    /*
     * ★★ THE ANSWER IS READ, WHICH IT WAS NOT BEFORE.
     *
     * This used to await the call, discard the result and report success —
     * so a 200 whose body said `{ ok: false }` rendered "signed out". The
     * request not throwing is not the same fact as the session being gone.
     */
    if (!result.ok) {
      logger.warn('security.revoke_unconfirmed', {});
      return { ok: false, reason: 'unconfirmed' };
    }
    revalidatePath('/[locale]/settings/security', 'page');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('security.revoke_failed', { cause });
    return classify(cause);
  }
}

/**
 * Signs out every OTHER session, keeping the caller's.
 *
 * The backend keeps the current one deliberately — a control that signs you
 * out of the device you are using cannot report whether it worked.
 */
export async function revokeOtherSessions(): Promise<SecurityWriteResult> {
  try {
    const result = await serverApi().delete({
      endpoint: securityEndpoints.revokeOtherSessions(),
      payload: revokeResultSchema,
      raw: true,
    });
    if (!result.ok) {
      logger.warn('security.revoke_all_unconfirmed', {});
      return { ok: false, reason: 'unconfirmed' };
    }
    revalidatePath('/[locale]/settings/security', 'page');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('security.revoke_all_failed', { cause });
    return classify(cause);
  }
}

/**
 * Tenant MFA enforcement.
 *
 * Both fields are sent together because they are one policy with two levels —
 * requiring it of everyone implies requiring it of admins, and sending one
 * without the other would let the two drift into a combination nobody chose.
 */
export async function setMfaPolicy(next: TenantSecurity): Promise<SecurityWriteResult> {
  try {
    await serverApi().patch({
      endpoint: securityEndpoints.tenantSecurity(),
      payload: tenantSecuritySchema,
      body: {
        mfaRequiredForAdmins: next.mfaRequiredForAdmins,
        mfaRequiredForAllUsers: next.mfaRequiredForAllUsers,
      },
    });
    revalidatePath('/[locale]/settings/security', 'page');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('security.mfa_policy_failed', { cause });
    return classify(cause);
  }
}
