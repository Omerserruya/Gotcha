import 'server-only';

import { serverApi } from '@/api/client/server-api';
import { domainJoinSchema, type DomainJoin } from '@/api/contracts/self-signup';
import { securityEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * Joining by the admin's email domain (Omer, 2026-11-22), or `null` when
 * unread - including while the route does not exist yet. `null` leaves the
 * row exactly as it was (02's "-"), so nothing changes until the server has it.
 */
export async function loadDomainJoin(): Promise<DomainJoin | null> {
  try {
    return await serverApi().get({
      endpoint: securityEndpoints.domainJoin(),
      payload: domainJoinSchema,
      raw: true,
    });
  } catch (cause) {
    logger.warn('security.domain_join_unread', { cause });
    return null;
  }
}
