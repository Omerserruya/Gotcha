import 'server-only';

import { serverApi } from '@/api/client/server-api';
import {
  integrationsSchema,
  toolPermissionsSchema,
  type Integration,
  type ToolPermission,
} from '@/api/contracts/integrations';
import { integrationEndpoints, toolPermissionEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * What screen 14 shows.
 *
 * Two reads, and the second is not optional decoration — it is the
 * authoritative one.
 *
 * `GET /api/integrations` carries the systems, their connection status and
 * each capability's ACTIVATION (`TenantTool.isEnabled`).
 * `GET /api/tool-permissions` carries the tenant's POLICY
 * (`TenantToolPermission.enabled` / `requiresApproval`), which the schema
 * declares authoritative over the activation.
 *
 * On this tenant they disagree: `process_refund` is activated and
 * policy-disabled. So a panel built from the first read alone would say the
 * AI may issue refunds when the owner has switched that off.
 *
 * Which is why **a failed policy read is not treated as "no policy"**. Empty
 * and unavailable are different facts, and here the difference is the
 * difference between showing a permissive state and knowing you cannot.
 */
export interface SystemsData {
  readonly integrations: readonly Integration[] | null;
  readonly permissions: readonly ToolPermission[];
  /** False when the policy read FAILED. Capability stances are unsafe then. */
  readonly policyLoaded: boolean;
}

export async function loadSystems(): Promise<SystemsData> {
  const api = serverApi();

  const [integrations, permissions] = await Promise.all([
    api
      .get({ endpoint: integrationEndpoints.list(), payload: integrationsSchema })
      .catch((cause: unknown) => {
        logger.warn('systems.list_failed', { cause });
        return null;
      }),
    api
      .get({ endpoint: toolPermissionEndpoints.list(), payload: toolPermissionsSchema })
      .catch((cause: unknown) => {
        logger.warn('systems.tool_permissions_failed', { cause });
        return null;
      }),
  ]);

  return {
    integrations,
    permissions: permissions ?? [],
    policyLoaded: permissions != null,
  };
}
