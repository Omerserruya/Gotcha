'use server';

import { revalidatePath } from 'next/cache';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import {
  deleteResultSchema,
  employeeSchema,
  type DeleteResult,
  type EmployeeStatus,
} from '@/api/contracts/employees';
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

/**
 * Deletes an AI employee, and reports what that actually did.
 *
 * The route runs one transaction: it neutralises the routing node that pointed
 * at the employee, clears the tenant default and any knowledge-base scope,
 * removes its tool grants, **releases its LIVE conversations** — clearing both
 * `assignedAiAgentId` and `handledBy` — and deletes the row.
 *
 * `handledBy` matters more than it looks. Nulling the employee id alone would
 * leave `isAiManaged()` true — it reads *handledBy in [ai_agent, flow] AND
 * !isHandedOver AND !assignedAgentId* — so a released conversation would file
 * itself under **"the AI is handling this"** and sit there unanswered while
 * the inbox told a human it was covered. Clearing both returns it to the
 * unrouted state the worker documents as "stays in inbox for manual pickup",
 * which is what lets the dialog promise it waits for someone to claim it.
 *
 * Closed conversations are **not** touched, on purpose. Their employee id is
 * the record of who handled them.
 */
export type DeleteEmployeeResult =
  | { readonly ok: true; readonly result: DeleteResult }
  | { readonly ok: false; readonly reason: 'forbidden' | 'gone' | 'failed' };

export async function deleteEmployee(id: string): Promise<DeleteEmployeeResult> {
  try {
    const result = await serverApi().delete({
      endpoint: employeeEndpoints.update(id),
      payload: deleteResultSchema,
    });
    revalidatePath('/[locale]/(app)/studio/employees', 'page');
    return { ok: true, result };
  } catch (cause) {
    if (isApiError(cause)) {
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
      if (cause.status === 404) return { ok: false, reason: 'gone' };
    }
    logger.warn('employees.delete_failed', { cause });
    return { ok: false, reason: 'failed' };
  }
}
