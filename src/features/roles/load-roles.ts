import 'server-only';

import { serverApi } from '@/api/client/server-api';
import { roleListSchema, type Role } from '@/api/contracts/roles';
import { permissionEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * The tenant's roles — screen 12b.
 *
 * `{ data }` with Prisma rows, so the contract flattens `_count.assignments`
 * into `memberCount` here rather than letting a Prisma aggregate shape reach
 * a component.
 *
 * `null` is a failed read and never an empty list. On this screen the two are
 * opposite reassurances: no roles would mean nobody can do anything, and a
 * failed read means you cannot tell who can.
 */
export async function loadRoles(): Promise<readonly Role[] | null> {
  try {
    return await serverApi().get({
      endpoint: permissionEndpoints.roles(),
      payload: roleListSchema,
      // `{ data }` is unwrapped by the transform itself, which needs the
      // envelope intact to read `_count` off each row.
      raw: true,
    });
  } catch (cause) {
    logger.warn('roles.list_failed', { cause });
    return null;
  }
}
