'use server';

import { revalidatePath } from 'next/cache';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { employeeSchema, type EmployeeStatus } from '@/api/contracts/employees';
import { employeeEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * Pause and resume. There is no third verb.
 *
 * `AIAgentStatus` is `ACTIVE | DRAFT | PAUSED`, so this function takes only
 * the two transitions the platform has. **Naming a `retire` action that set
 * some other status would be inventing a lifecycle** — the screen says
 * plainly that firing is not something the product does.
 */
export type EmployeeWriteResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: 'forbidden' | 'gone' | 'failed' };

export async function setEmployeeStatus(
  id: string,
  status: Extract<EmployeeStatus, 'ACTIVE' | 'PAUSED'>,
): Promise<EmployeeWriteResult> {
  try {
    await serverApi().patch({
      endpoint: employeeEndpoints.update(id),
      payload: employeeSchema,
      body: { status },
    });
    revalidatePath('/[locale]/(app)/studio/employees', 'page');
    return { ok: true };
  } catch (cause) {
    if (isApiError(cause)) {
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
      if (cause.status === 404) return { ok: false, reason: 'gone' };
    }
    logger.warn('employees.status_failed', { cause, status });
    return { ok: false, reason: 'failed' };
  }
}
