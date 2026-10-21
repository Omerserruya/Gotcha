'use server';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import {
  acceptedInvitationSchema,
  EMAIL_ALREADY_IN_TENANT,
  EMAIL_REQUIRED,
  INVITE_INVALID,
} from '@/api/contracts/invitation';
import { publicLinkEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * Accepting an invitation (legacy `frontend/src/app/join/page.tsx`).
 *
 * It takes no password: accepting links the person to the workspace, and the
 * credential is set in Authentik through `setupLink`. Null there means the
 * person already has one - they sign in.
 *
 * Nothing here logs the token, the name or the address.
 */
export type AcceptInviteResult =
  | { readonly ok: true; readonly setupLink: string | null }
  /** Used, expired or unknown - the route does not say which. */
  | { readonly ok: false; readonly reason: 'invalid' }
  /** An open link with no address typed. */
  | { readonly ok: false; readonly reason: 'email_required' }
  /** That address is already a member of this workspace. */
  | { readonly ok: false; readonly reason: 'already_member' }
  /** The name or address did not pass the route's checks. */
  | { readonly ok: false; readonly reason: 'invalid_input' }
  | { readonly ok: false; readonly reason: 'failed' };

export async function acceptInvite(input: {
  readonly token: string;
  readonly name: string;
  /** Only for an open link; an invitation with a fixed address ignores it. */
  readonly email?: string;
}): Promise<AcceptInviteResult> {
  const email = input.email?.trim().toLowerCase();
  try {
    const accepted = await serverApi().post({
      endpoint: publicLinkEndpoints.acceptInvite(),
      payload: acceptedInvitationSchema,
      body: { token: input.token, name: input.name.trim(), ...(email ? { email } : {}) },
    });
    return { ok: true, setupLink: safeLink(accepted.setupLink) };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('join.accept_failed', { cause });
    if (isApiError(cause)) {
      if (cause.status === 404 || cause.developerMessage === INVITE_INVALID) {
        return { ok: false, reason: 'invalid' };
      }
      if (cause.developerMessage === EMAIL_REQUIRED) return { ok: false, reason: 'email_required' };
      if (cause.developerMessage === EMAIL_ALREADY_IN_TENANT) {
        return { ok: false, reason: 'already_member' };
      }
      if (cause.status === 400) return { ok: false, reason: 'invalid_input' };
    }
    return { ok: false, reason: 'failed' };
  }
}

/**
 * ⚠ The browser is sent wherever this says, so only a web address passes.
 *   It is the backend's own redeem URL; anything else (`javascript:`, a
 *   relative path) is read as "no link" and the person signs in instead.
 */
function safeLink(link: string | null): string | null {
  if (!link || !URL.canParse(link)) return null;
  const url = new URL(link);
  return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
}
