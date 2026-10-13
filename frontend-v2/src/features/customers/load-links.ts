import 'server-only';

import { serverApi } from '@/api/client/server-api';
import { identityLinksSchema, type IdentityLinks } from '@/api/contracts/identity';
import { identityEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/** F1: who this customer is linked to, and how - `null` when the read failed. */
export async function loadIdentityLinks(contactId: string): Promise<IdentityLinks | null> {
  return serverApi()
    .get({ endpoint: identityEndpoints.links(contactId), payload: identityLinksSchema })
    .catch((cause: unknown) => {
      logger.warn('customers.links_failed', { cause });
      return null;
    });
}
