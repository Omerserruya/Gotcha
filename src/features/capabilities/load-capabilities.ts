import 'server-only';

import { serverApi } from '@/api/client/server-api';
import { capabilityListSchema, type Capability } from '@/api/contracts/capabilities';
import { capabilityEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * What GOTCHA is allowed to do.
 *
 * `{ data }` enveloped. `null` is a failed read and never an empty list: the
 * difference on this screen is between "GOTCHA can do nothing" and "you
 * cannot see what it can do", which are not the same reassurance.
 */
export async function loadCapabilities(): Promise<readonly Capability[] | null> {
  try {
    return await serverApi().get({
      endpoint: capabilityEndpoints.list(),
      payload: capabilityListSchema,
    });
  } catch (cause) {
    logger.warn('capabilities.list_failed', { cause });
    return null;
  }
}
