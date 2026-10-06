import 'server-only';

import { personDetailSchema, type Person } from '@/api/contracts/roles';
import { permissionEndpoints } from '@/api/endpoints/registry';
import { serverApi } from '@/api/client/server-api';
import { logger } from '@/observability/logger';

/**
 * One person - screen 12d.
 *
 * `raw` because the transform needs the `{ data }` envelope intact: the route
 * nests `user` inside it beside `roles`, `grants` and the effective
 * `permissions`, and flattening happens in the contract rather than here.
 */
export async function loadPerson(userId: string): Promise<Person | null> {
  try {
    return await serverApi().get({
      endpoint: permissionEndpoints.user(userId),
      payload: personDetailSchema,
      raw: true,
    });
  } catch (cause) {
    logger.warn('person.load_failed', { cause, userId });
    return null;
  }
}
