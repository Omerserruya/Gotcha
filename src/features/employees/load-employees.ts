import 'server-only';

import { serverApi } from '@/api/client/server-api';
import { employeeListSchema, type Employee } from '@/api/contracts/employees';
import { employeeEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * The tenant's AI employees.
 *
 * `{ data }` enveloped. `null` is a failed read and never an empty roster: on
 * this screen the two mean opposite things, because having no employees is
 * why nothing is being answered.
 */
export async function loadEmployees(): Promise<readonly Employee[] | null> {
  try {
    return await serverApi().get({
      endpoint: employeeEndpoints.list(),
      payload: employeeListSchema,
    });
  } catch (cause) {
    logger.warn('employees.list_failed', { cause });
    return null;
  }
}
