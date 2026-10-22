import 'server-only';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { slaSettingsSchema, type SlaSettings } from '@/api/contracts/sla';
import { workspaceEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

import type { SlaClock } from './sla-clock';

/**
 * The workspace's response target, or `null` - read alongside the list.
 * A 403 (anyone but an Owner, today) is the route's answer, not a fault, and
 * is not logged; anything else is.
 */
export async function loadSlaSettings(): Promise<SlaSettings | null> {
  return serverApi()
    .get({ endpoint: workspaceEndpoints.sla(), payload: slaSettingsSchema })
    .catch((cause: unknown) => {
      if (!(isApiError(cause) && cause.status === 403)) logger.warn('inbox.sla_failed', { cause });
      return null;
    });
}

/**
 * The clock the rows are timed by: the workspace's target, and the override
 * of each department on this page - only those, once each. `null` when there
 * is no target to time by (unread, switched off, no minutes).
 */
export async function loadSlaClock(
  settings: SlaSettings | null,
  departmentIds: readonly string[],
): Promise<SlaClock | null> {
  if (settings === null || !settings.enabled || settings.slaMinutes === null) return null;
  const api = serverApi();
  const entries = await Promise.all(
    [...new Set(departmentIds)].map((id) =>
      api
        .get({ endpoint: workspaceEndpoints.slaDepartment(id), payload: slaSettingsSchema })
        .then((own): [string, number | 'workspace'] => [
          id,
          own.enabled && own.slaMinutes !== null ? own.slaMinutes : 'workspace',
        ])
        .catch((cause: unknown): [string, 'unread'] => {
          logger.warn('inbox.sla_department_failed', { cause, departmentId: id });
          return [id, 'unread'];
        }),
    ),
  );
  return {
    minutes: settings.slaMinutes,
    warningPercent: settings.warningThreshold,
    departments: Object.fromEntries(entries),
  };
}
