import 'server-only';

import { serverApi } from '@/api/client/server-api';
import { aiAlertsSchema, aiFailuresSchema, type AiFailures } from '@/api/contracts/ai-failures';
import { tenantListSchema } from '@/api/contracts/console';
import { consoleEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

export interface AiFailureFilters {
  readonly hours: number;
  readonly tenantId: string;
  readonly tool: string;
}

/** The failures for the filters. `null` when unread - never drawn as "none failed". */
export async function loadAiFailures(filters: AiFailureFilters): Promise<AiFailures | null> {
  return serverApi()
    .get({
      endpoint: consoleEndpoints.aiFailures(),
      query: {
        hours: filters.hours,
        tenantId: filters.tenantId || undefined,
        tool: filters.tool || undefined,
      },
      payload: aiFailuresSchema,
      raw: true,
    })
    .catch((cause: unknown) => {
      logger.warn('console.ai_failures_failed', { cause });
      return null;
    });
}

/**
 * The console badge: groups over Backend's threshold in the last hour.
 * `null` when unread - then no badge, rather than a 0 that says "all fine".
 */
export async function loadAiAlertCount(): Promise<number | null> {
  return serverApi()
    .get({ endpoint: consoleEndpoints.aiAlerts(), payload: aiAlertsSchema, raw: true })
    .then((alerts) => alerts.count)
    .catch((cause: unknown) => {
      logger.warn('console.ai_alerts_failed', { cause });
      return null;
    });
}

/** Enough for every tenant on the platform today; the route takes `limit` as given. */
const NAMES_LIMIT = 500;

/** Tenant id → name, for the rows and the filter. Empty when unread: the id is shown instead. */
export async function loadTenantNames(): Promise<ReadonlyMap<string, string>> {
  return serverApi()
    .get({
      endpoint: consoleEndpoints.tenants(),
      query: { limit: NAMES_LIMIT },
      payload: tenantListSchema,
      raw: true,
    })
    .then((list) => new Map(list.data.map((tenant) => [tenant.id, tenant.name])))
    .catch((cause: unknown) => {
      logger.warn('console.tenant_names_failed', { cause });
      return new Map<string, string>();
    });
}
