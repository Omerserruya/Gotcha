import 'server-only';

import { cache } from 'react';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { effectivePermissionsSchema } from '@/api/contracts/identity';
import { permissionEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';
import type { PermissionsStatus } from '@/permissions/permissions-context';

/**
 * Fetches the caller's effective permissions.
 *
 * A failure does NOT degrade to an empty set. With exact matching an empty set
 * hides every gated destination, which is indistinguishable from having had
 * access revoked - an operator would be left staring at a product with no
 * navigation and no explanation.
 *
 * Instead the status is `unavailable` and the interface stops gating. The
 * backend remains the security authority, so nothing is actually granted; the
 * worst case is a control that turns out to be refused, with an error that
 * says so.
 */
async function readPermissions(): Promise<{
  permissions: readonly string[];
  roleKey?: string;
  status: PermissionsStatus | 'signed_out';
}> {
  try {
    const result = await serverApi().get({
      endpoint: permissionEndpoints.mine(),
      payload: effectivePermissionsSchema,
    });
    return {
      // `features` is the legacy list; it is only a fallback for a tenant the
      // canonical set has not been migrated for.
      permissions: result.permissions.length > 0 ? result.permissions : result.features,
      roleKey: result.roleKey,
      status: 'loaded',
    };
  } catch (cause) {
    if (isApiError(cause) && cause.status === 401) return { permissions: [], status: 'signed_out' };
    logger.warn('permissions.load_failed', { cause });
    // Not an empty set. An empty set means "you hold nothing" and would hide
    // the entire product; `unavailable` means "we could not find out", and the
    // interface stops gating rather than pretending to know.
    return { permissions: [], status: 'unavailable' };
  }
}

/**
 * Once per request: the app layout reads it for the shell, and a page that
 * decides by permission on the server (/studio, S1) reads the same answer -
 * never a second request, never a second opinion.
 */
export const loadPermissions = cache(readPermissions);
