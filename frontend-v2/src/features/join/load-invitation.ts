import 'server-only';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { invitationSchema, type Invitation } from '@/api/contracts/invitation';
import { publicLinkEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * What `/join?token=` can show.
 *
 *   missing      no token in the link - nothing to ask about
 *   used         the route answered 404 with reason "used": accepted already
 *   expired      ... reason "expired": past its date
 *   invalid      ... reason "invalid", or no reason (a server from before
 *                Backend b0ed4d81): a token that matches nothing
 *   unreachable  anything else - a timeout, a 5xx. NOT "invalid": the link may
 *                be fine, and telling somebody it is dead sends them to ask
 *                for a new one they do not need
 *   valid        the invitation, ready to accept
 */
export type InvitationRead =
  | { readonly state: 'missing' }
  | { readonly state: DeadInvitation }
  | { readonly state: 'unreachable' }
  | { readonly state: 'valid'; readonly invitation: Invitation };

/** Why an invitation cannot be used (Backend b0ed4d81's `reason`). */
export type DeadInvitation = 'used' | 'expired' | 'invalid';

/** The 404's `reason`; anything else, or none, is "invalid". */
export function deadReason(reason: string | undefined): DeadInvitation {
  return reason === 'used' || reason === 'expired' ? reason : 'invalid';
}

export async function loadInvitation(token: string | undefined): Promise<InvitationRead> {
  if (!token) return { state: 'missing' };
  try {
    const invitation = await serverApi().get({
      endpoint: publicLinkEndpoints.invite(token),
      payload: invitationSchema,
    });
    return { state: 'valid', invitation };
  } catch (cause) {
    if (isApiError(cause) && cause.status === 404) return { state: deadReason(cause.reason) };
    logger.warn('join.invite_read_failed', { cause });
    return { state: 'unreachable' };
  }
}
