import 'server-only';

import type { Employee } from '@/api/contracts/employees';

import { loadReadinessStatus } from './load-readiness-status';
import { readinessRun, type ReadinessRun } from './readiness';

/**
 * The readiness run of one employee, read now: its stored status, judged by
 * the employee page's own rule (readiness.ts). For 07e, which opens the
 * moment a hire completes - while the run that follows it is still running.
 */
export async function loadReadinessRun(employee: Employee): Promise<ReadinessRun> {
  return readinessRun(employee, await loadReadinessStatus(employee.id), Date.now());
}
