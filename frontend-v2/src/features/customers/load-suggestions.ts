import 'server-only';

import { identitySuggestionsSchema, type IdentitySuggestion } from '@/api/contracts/identity';
import { serverApi } from '@/api/client/server-api';
import { identityEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * 04's pairs that look like one person - the server's, and only the server's
 * (`GET /api/identity/suggestions`, Backend 83579ac8). Nothing on this screen
 * pairs customers itself any more. `null` is a failed read, logged: the card
 * is then not drawn at all, never drawn empty or as "no duplicates".
 */
export async function loadSuggestions(): Promise<readonly IdentitySuggestion[] | null> {
  try {
    return await serverApi().get({
      endpoint: identityEndpoints.suggestions(),
      payload: identitySuggestionsSchema,
    });
  } catch (cause) {
    logger.warn('customers.suggestions_failed', { cause });
    return null;
  }
}
