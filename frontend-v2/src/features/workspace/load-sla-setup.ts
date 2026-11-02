import 'server-only';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { currentUserSchema } from '@/api/contracts/identity';
import { departmentsSchema } from '@/api/contracts/people';
import { slaSettingsSchema, type SlaSettings } from '@/api/contracts/sla';
import { authEndpoints, departmentEndpoints, workspaceEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';
import { isSystemAdminRole } from '@/permissions/permission-set';

/**
 * The response target for Settings · Workspace (W2), and what reaching it
 * alerts.
 *
 * ★ READ IS NOT WRITE (auth agents.ts, 41755eb2): the GET is open to anyone
 *   with `conversation:messages:read`, the PUTs are `requireRole("ADMIN")` -
 *   Owner and Admin, one role since 2026-10-11. So a read that answers says
 *   nothing about who may change it: `owner` (the shared name for "may
 *   edit") only for the admin role, `readOnly` for everyone else who reads
 *   it - the value, and no Edit that could not save. An unread role is not
 *   admin. A 403 on the read: the row says whose it is.
 */
export type SlaSetup =
  | { readonly kind: 'owner'; readonly settings: SlaSettings }
  | { readonly kind: 'readOnly'; readonly settings: SlaSettings }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'failed' };

export async function loadSlaSetup(): Promise<SlaSetup> {
  const api = serverApi();
  const [setup, role] = await Promise.all([
    api
      .get({ endpoint: workspaceEndpoints.sla(), payload: slaSettingsSchema })
      .then((settings) => ({ kind: 'read' as const, settings }))
      .catch((cause: unknown): SlaSetup => {
        if (isApiError(cause) && cause.status === 403) return { kind: 'forbidden' };
        logger.warn('workspace.sla_failed', { cause });
        return { kind: 'failed' };
      }),
    api
      .get({ endpoint: authEndpoints.me(), payload: currentUserSchema })
      .then((me) => me.user.role ?? null)
      .catch((cause: unknown) => {
        logger.warn('workspace.sla_role_unread', { cause });
        return null;
      }),
  ]);
  if (setup.kind !== 'read') return setup;
  const admin = role === 'ADMIN' || isSystemAdminRole(role);
  return { kind: admin ? 'owner' : 'readOnly', settings: setup.settings };
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
