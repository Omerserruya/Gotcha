import 'server-only';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { currentUserSchema } from '@/api/contracts/identity';
import { authEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

import { mayPreviewOnboarding, workspaceRoute, type WorkspaceRoute } from './workspace-gate';

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
  /** A live workspace's admin: onboarding may be walked as a preview. */
  readonly mayPreview: boolean;
  /**
   * ★★ THE WORKSPACE THE REALTIME SOCKET IS FOR. The session cookie has a
   * `tid` slot that no sign-in has ever filled, so the provider was handed
   * `null` and never opened a socket: new messages appeared only on a reload
   * (2026-10-11). `/api/auth/me` names the tenant the token acts in.
   */
  readonly tenantId: string | null;
}> {
  try {
    const me = await serverApi().get({ endpoint: authEndpoints.me(), payload: currentUserSchema });
    const who = { tenantStatus: me.tenantStatus ?? null, role: me.user.role ?? null };
    return {
      route: workspaceRoute(who),
      setupAdmin: me.setupAdmin?.name?.trim() || null,
      mayPreview: mayPreviewOnboarding(who),
      tenantId: me.user.tenantId || null,
    };
  } catch (cause) {
    if (isApiError(cause) && cause.status === 401) {
      return { route: 'signed_out', setupAdmin: null, mayPreview: false, tenantId: null };
    }
    logger.warn('gate.me_failed', { status: isApiError(cause) ? cause.status : undefined });
    return { route: 'unavailable', setupAdmin: null, mayPreview: false, tenantId: null };
  }
}
