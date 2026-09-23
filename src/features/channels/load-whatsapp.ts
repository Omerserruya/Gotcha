import 'server-only';

import { numbersResponseSchema, type NumbersResponse } from '@/api/contracts/whatsapp-numbers';
import { channelEndpoints } from '@/api/endpoints/registry';
import { serverApi } from '@/api/client/server-api';
import { logger } from '@/observability/logger';

/**
 * WhatsApp numbers — screen 13.
 *
 * One read, and the failure is NOT degraded into an empty list. An empty list
 * on this screen means "you have no WhatsApp numbers", which is a statement
 * about the workspace; a failed read is a statement about us. Conflating them
 * would tell somebody whose numbers are working that they have none.
 */
export async function loadWhatsAppNumbers(): Promise<NumbersResponse | null> {
  return serverApi()
    .get({
      endpoint: channelEndpoints.whatsappNumbers(),
      payload: numbersResponseSchema,
      // `{ data, unprofiled }` — the second array has no envelope of its own,
      // so the response is needed whole.
      raw: true,
    })
    .catch((cause: unknown) => {
      logger.warn('whatsapp.numbers_failed', { cause });
      return null;
    });
}
