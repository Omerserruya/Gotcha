import 'server-only';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { currentUserSchema } from '@/api/contracts/identity';
import { authEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

import { workspaceRoute, type WorkspaceRoute } from './workspace-gate';

export { paymentPath } from '@/api/client/payment-path';

/**
 * The gate's read: who this is and where the workspace stands, from
 * `/api/auth/me`. A 401 is "signed out" (the caller sends them to sign in);
 * any other failure is "unread" - the gate screen, with Retry.
 */
export async function readWorkspaceRoute(): Promise<WorkspaceRoute | 'signed_out'> {
  try {
    const me = await serverApi().get({ endpoint: authEndpoints.me(), payload: currentUserSchema });
    return workspaceRoute({
      tenantStatus: me.tenantStatus ?? null,
      role: me.user.role ?? null,
    });
  } catch (cause) {
    if (isApiError(cause) && cause.status === 401) return 'signed_out';
    logger.warn('gate.me_failed', { status: isApiError(cause) ? cause.status : undefined });
    return 'unavailable';
  }
}
