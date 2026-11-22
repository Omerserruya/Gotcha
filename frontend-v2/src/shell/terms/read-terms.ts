import 'server-only';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { termsStateSchema } from '@/api/contracts/google-sign-in';
import { securityEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * `GET /api/account/terms`: `true` owed, `false` not, `null` unread (a 503,
 * or anything else). The gate holds "owed" on `null` (Backend: never read an
 * unanswered question as false) - it only asks while the sign-in's marker
 * says the Terms were owed, so "owed" is the answer it already holds.
 */
export async function readTermsRequired(): Promise<boolean | null> {
  try {
    const state = await serverApi().get({
      endpoint: securityEndpoints.terms(),
      payload: termsStateSchema,
    });
    return state.termsRequired;
  } catch (cause) {
    logger.warn('terms.gate_unread', { status: isApiError(cause) ? cause.status : undefined });
    return null;
  }
}
