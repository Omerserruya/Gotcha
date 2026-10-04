import 'server-only';

import { numbersResponseSchema } from '@/api/contracts/whatsapp-numbers';
import { serverApi } from '@/api/client/server-api';
import { channelEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * Is a real Meta WhatsApp Business account connected? (Omer: a campaign's
 * Send and a template's Submit to Meta only then.)
 *
 * A profiled number — one connected through Meta's Embedded Signup — is
 * stored with its WABA; a legacy channel ("unprofiled", like dev's Demo
 * WhatsApp) is not, and Meta refuses a template submitted through it. So:
 * true when any profiled number is connected (or connected and degraded).
 * `null` when the read failed — then nothing is offered, and it says why.
 */
export async function wabaConnected(): Promise<boolean | null> {
  try {
    const numbers = await serverApi().get({
      endpoint: channelEndpoints.whatsappNumbers(),
      payload: numbersResponseSchema,
      raw: true,
    });
    return numbers.data.some((n) => n.state === 'CONNECTED' || n.state === 'DEGRADED');
  } catch (cause) {
    logger.warn('outreach.waba_read_failed', { cause });
    return null;
  }
}
