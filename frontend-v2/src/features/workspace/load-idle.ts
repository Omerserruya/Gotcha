import 'server-only';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { idleAutomationSchema, type IdleAutomation } from '@/api/contracts/idle-automation';
import { workspaceEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * Follow-up and auto-close for Settings · Workspace (S3). Owner only on the
 * server, the read included: anyone else reads a 403, and the row says whose
 * it is rather than offering an Edit that could not save.
 */
export type IdleSetup =
  | { readonly kind: 'owner'; readonly settings: IdleAutomation }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'failed' };

export async function loadIdleSetup(): Promise<IdleSetup> {
  return serverApi()
    .get({ endpoint: workspaceEndpoints.idleAutomation(), payload: idleAutomationSchema })
    .then((settings): IdleSetup => ({ kind: 'owner', settings }))
    .catch((cause: unknown): IdleSetup => {
      if (isApiError(cause) && cause.status === 403) return { kind: 'forbidden' };
      logger.warn('workspace.idle_failed', { cause });
      return { kind: 'failed' };
    });
}
