import 'server-only';

import { serverApi } from '@/api/client/server-api';
import {
  employeeListSchema,
  integrationAccessSchema,
  type Employee,
  type IntegrationAccess,
} from '@/api/contracts/employees';
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

/**
 * The business systems this employee may use, and every one the workspace
 * has set up. `null` is a failed read - never "may use nothing".
 */
export async function loadIntegrationAccess(id: string): Promise<IntegrationAccess | null> {
  try {
    return await serverApi().get({
      endpoint: employeeEndpoints.integrationAccess(id),
      payload: integrationAccessSchema,
    });
  } catch (cause) {
    logger.warn('employees.integration_access_failed', { cause });
    return null;
  }
}
