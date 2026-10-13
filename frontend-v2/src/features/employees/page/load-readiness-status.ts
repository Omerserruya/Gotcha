import 'server-only';

import { serverApi } from '@/api/client/server-api';
import { readinessRunStatusSchema, type ReadinessRunStatus } from '@/api/contracts/employees';
import { employeeEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * H7: is its readiness test running, done, or failed - from the employee's
 * own read (`GET /api/ai-agents/:id`, Backend 94ccaead); the list route does
 * not carry it. `null` when the read failed.
 */
export async function loadReadinessStatus(id: string): Promise<ReadinessRunStatus | null> {
  return serverApi()
    .get({ endpoint: employeeEndpoints.detail(id), payload: readinessRunStatusSchema })
    .catch((cause: unknown) => {
      logger.warn('employees.readiness_status_failed', { cause });
      return null;
    });
}
