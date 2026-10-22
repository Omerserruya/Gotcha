import 'server-only';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { departmentsSchema } from '@/api/contracts/people';
import { slaSettingsSchema, type SlaSettings } from '@/api/contracts/sla';
import { departmentEndpoints, workspaceEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * The response target for Settings · Workspace (W2): the Owner's to read and
 * set (the routes are `requireRole("ADMIN")`, the PUTs included). Anyone else
 * reads a 403, and the row says whose it is rather than offering an Edit
 * that could not save.
 */
export type SlaSetup =
  | { readonly kind: 'owner'; readonly settings: SlaSettings }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'failed' };

export async function loadSlaSetup(): Promise<SlaSetup> {
  return serverApi()
    .get({ endpoint: workspaceEndpoints.sla(), payload: slaSettingsSchema })
    .then((settings): SlaSetup => ({ kind: 'owner', settings }))
    .catch((cause: unknown): SlaSetup => {
      if (isApiError(cause) && cause.status === 403) return { kind: 'forbidden' };
      logger.warn('workspace.sla_failed', { cause });
      return { kind: 'failed' };
    });
}

/** One department in the drawer: its own target, or `null` when it could not be read. */
export interface DepartmentSla {
  readonly id: string;
  readonly name: string;
  readonly own: SlaSettings | null;
}

/**
 * The departments and each one's own target - read only when the drawer is
 * open. `null` when the departments could not be read: the workspace's target
 * is still editable without them.
 */
export async function loadDepartmentSlas(): Promise<readonly DepartmentSla[] | null> {
  const api = serverApi();
  const departments = await api
    .get({ endpoint: departmentEndpoints.list(), payload: departmentsSchema })
    .catch((cause: unknown) => {
      logger.warn('workspace.departments_failed', { cause });
      return null;
    });
  if (departments === null) return null;
  return Promise.all(
    departments
      .filter((department) => department.isActive)
      .map(async (department) => ({
        id: department.id,
        name: department.name,
        own: await api
          .get({
            endpoint: workspaceEndpoints.slaDepartment(department.id),
            payload: slaSettingsSchema,
          })
          .catch((cause: unknown) => {
            logger.warn('workspace.department_sla_failed', { cause, departmentId: department.id });
            return null;
          }),
      })),
  );
}
