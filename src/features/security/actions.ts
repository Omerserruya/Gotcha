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
    await serverApi().delete({
      endpoint: securityEndpoints.revokeSession(id),
      payload: revokeResultSchema,
      raw: true,
    });
    revalidatePath('/[locale]/settings/security', 'page');
    return { ok: true };
  } catch (cause) {
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
    await serverApi().delete({
      endpoint: securityEndpoints.revokeOtherSessions(),
      payload: revokeResultSchema,
      raw: true,
    });
    revalidatePath('/[locale]/settings/security', 'page');
    return { ok: true };
  } catch (cause) {
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
    logger.warn('security.mfa_policy_failed', { cause });
    return classify(cause);
  }
}
