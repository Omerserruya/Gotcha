import 'server-only';

import { serverApi } from '@/api/client/server-api';
import { employeeToolsSchema, type EmployeeTool } from '@/api/contracts/employees';
import { employeeEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/** E5: this employee's actions and their levels; `null` when the read failed. */
export async function loadEmployeeTools(id: string): Promise<readonly EmployeeTool[] | null> {
  return serverApi()
    .get({ endpoint: employeeEndpoints.tools(id), payload: employeeToolsSchema })
    .catch((cause: unknown) => {
      logger.warn('employees.tools_failed', { cause });
      return null;
    });
}
