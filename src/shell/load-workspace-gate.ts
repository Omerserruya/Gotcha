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
  return (await readWorkspaceGate()).route;
}

/** The route, and - for the waiting screen - who is setting the workspace up. */
export async function readWorkspaceGate(): Promise<{
  readonly route: WorkspaceRoute | 'signed_out';
  readonly setupAdmin: string | null;
}> {
  try {
    const me = await serverApi().get({ endpoint: authEndpoints.me(), payload: currentUserSchema });
    return {
      route: workspaceRoute({ tenantStatus: me.tenantStatus ?? null, role: me.user.role ?? null }),
      setupAdmin: me.setupAdmin?.name?.trim() || null,
    };
  } catch (cause) {
    if (isApiError(cause) && cause.status === 401) return { route: 'signed_out', setupAdmin: null };
    logger.warn('gate.me_failed', { status: isApiError(cause) ? cause.status : undefined });
    return { route: 'unavailable', setupAdmin: null };
  }
}
