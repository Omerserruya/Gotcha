import 'server-only';

import { serverApi } from '@/api/client/server-api';
import { automationListSchema, type Automation } from '@/api/contracts/automations';
import { automationEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * The tenant's automations.
 *
 * `raw` because the route answers a **bare array** with no envelope — the
 * fourth response shape on this platform, and the only one where unwrapping
 * `data` would throw away the whole response rather than part of it.
 *
 * `null` is a failed read and never an empty list: on this screen the
 * difference is whether nothing is running or whether you cannot tell.
 */
export async function loadAutomations(): Promise<readonly Automation[] | null> {
  try {
    return await serverApi().get({
      endpoint: automationEndpoints.list(),
      payload: automationListSchema,
      raw: true,
    });
  } catch (cause) {
    logger.warn('automations.list_failed', { cause });
    return null;
  }
}
