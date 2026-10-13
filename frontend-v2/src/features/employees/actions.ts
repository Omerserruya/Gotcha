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
import { signInIfSignedOut } from '@/api/client/signed-out';

/**
 * Pause and resume. There is no third verb.
 *
 * `AIAgentStatus` is `ACTIVE | DRAFT | PAUSED`, so this function takes only
 * the two transitions the platform has. **Naming a `retire` action that set
 * some other status would be inventing a lifecycle** - the screen says
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
    await signInIfSignedOut(cause);
    if (isApiError(cause)) {
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
      if (cause.status === 404) return { ok: false, reason: 'gone' };
    }
    logger.warn('employees.status_failed', { cause, status });
    return { ok: false, reason: 'failed' };
  }
}

/**
 * The employee page's Save (Omer, 2026-10-08: editing a working employee is
 * approved) - the Profile tab's and the Knowledge tab's. One PATCH with only
 * what changed, each field under the route's own name (`editPatch`): it
 * applies from the employee's next reply, in the conversations open now too
 * - the confirmation says so before this runs.
 *
 * `invalid_access`: 422 INVALID_INTEGRATION_ACCESS - a system in the list
 * that is not one of the workspace's (disconnected meanwhile).
 * `invalid_rules`: 400 INVALID_ESCALATION_RULES - a handover condition the
 * route refuses (no words, over 300 characters, more than 50).
 */
export type EmployeeEditResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'forbidden' | 'gone' | 'invalid_access' | 'invalid_rules' | 'failed';
    };

export async function saveEmployeeEdits(
  id: string,
  patch: Readonly<Record<string, unknown>>,
): Promise<EmployeeEditResult> {
  try {
    await serverApi().patch({
      endpoint: employeeEndpoints.update(id),
      payload: employeeSchema,
      body: patch,
    });
    // The list and the employee's own page under it.
    revalidatePath('/[locale]/(app)/studio/employees', 'layout');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    if (isApiError(cause)) {
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
      if (cause.status === 404) return { ok: false, reason: 'gone' };
      if (cause.code === 'INVALID_INTEGRATION_ACCESS')
        return { ok: false, reason: 'invalid_access' };
      if (cause.code === 'INVALID_ESCALATION_RULES') return { ok: false, reason: 'invalid_rules' };
    }
    logger.warn('employees.edit_failed', { status: isApiError(cause) ? cause.status : undefined });
    return { ok: false, reason: 'failed' };
  }
}

/**
 * Deletes an AI employee, and reports what that actually did.
 *
 * The route runs one transaction: it neutralises the routing node that pointed
 * at the employee, clears the tenant default and any knowledge-base scope,
 * removes its tool grants, **releases its LIVE conversations** - clearing both
 * `assignedAiAgentId` and `handledBy` - and deletes the row.
 *
 * `handledBy` matters more than it looks. Nulling the employee id alone would
 * leave `isAiManaged()` true - it reads *handledBy in [ai_agent, flow] AND
 * !isHandedOver AND !assignedAgentId* - so a released conversation would file
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
    await signInIfSignedOut(cause);
    if (isApiError(cause)) {
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
      if (cause.status === 404) return { ok: false, reason: 'gone' };
    }
    logger.warn('employees.delete_failed', { cause });
    return { ok: false, reason: 'failed' };
  }
}
