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
 *   invalid      the route answered 404: used, expired or unknown (it does
 *                not say which, and neither does the screen)
 *   unreachable  anything else - a timeout, a 5xx. NOT "invalid": the link may
 *                be fine, and telling somebody it is dead sends them to ask
 *                for a new one they do not need
 *   valid        the invitation, ready to accept
 */
export type InvitationRead =
  | { readonly state: 'missing' }
  | { readonly state: 'invalid' }
  | { readonly state: 'unreachable' }
  | { readonly state: 'valid'; readonly invitation: Invitation };

export async function loadInvitation(token: string | undefined): Promise<InvitationRead> {
  if (!token) return { state: 'missing' };
  try {
    const invitation = await serverApi().get({
      endpoint: publicLinkEndpoints.invite(token),
      payload: invitationSchema,
    });
    return { state: 'valid', invitation };
  } catch (cause) {
    if (isApiError(cause) && cause.status === 404) return { state: 'invalid' };
    logger.warn('join.invite_read_failed', { cause });
    return { state: 'unreachable' };
  }
}
