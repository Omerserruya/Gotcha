import 'server-only';

import { serverApi } from '@/api/client/server-api';
import { signInConnectionsSchema, type GoogleConnection } from '@/api/contracts/google-sign-in';
import { securityEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * The connected-accounts card's read (Google sign-in, 2026-11-22).
 *
 * - `off`: Google is not set up in this environment (`available: false`) -
 *   the card is not drawn at all.
 * - `unread`: the request failed, `409 no_identity` (a legacy row with no
 *   identity behind it) or `502 idp_unavailable` - "we couldn't read", as
 *   the device routes say it, never "not connected".
 */
export type GoogleCard =
  | { readonly kind: 'off' }
  | { readonly kind: 'unread' }
  | { readonly kind: 'read'; readonly google: GoogleConnection };

export async function loadGoogleConnection(): Promise<GoogleCard> {
  try {
    const { google } = await serverApi().get({
      endpoint: securityEndpoints.signInConnections(),
      payload: signInConnectionsSchema,
      raw: true,
    });
    return google.available ? { kind: 'read', google } : { kind: 'off' };
  } catch (cause) {
    logger.warn('security.google_connection_unread', { cause });
    return { kind: 'unread' };
  }
}
