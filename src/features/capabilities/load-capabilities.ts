import 'server-only';

import { serverApi } from '@/api/client/server-api';
import {
  capabilityListSchema,
  toolUsageListSchema,
  type Capability,
  type ToolUsage,
} from '@/api/contracts/capabilities';
import { analyticsEndpoints, capabilityEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * What GOTCHA is allowed to do.
 *
 * `{ data }` enveloped. `null` is a failed read and never an empty list: the
 * difference on this screen is between "GOTCHA can do nothing" and "you
 * cannot see what it can do", which are not the same reassurance.
 */
export interface CapabilityData {
  readonly capabilities: readonly Capability[] | null;
  /**
   * How often each tool has actually run.
   *
   * `null` when the read failed — which is NOT "never used". The screen says
   * nothing about a tool's history rather than printing a zero, because
   * "used 0 times" is a claim and a failed read is not evidence for it.
   *
   * Degrades on its own: a permissions list that arrives without its usage
   * counts is still the screen's main answer.
   */
  readonly usage: readonly ToolUsage[] | null;
}

export async function loadCapabilities(): Promise<CapabilityData> {
  const api = serverApi();

  const [capabilities, usage] = await Promise.all([
    api
      .get({ endpoint: capabilityEndpoints.list(), payload: capabilityListSchema })
      .catch((cause: unknown) => {
        logger.warn('capabilities.list_failed', { cause });
        return null;
      }),
    /*
     * ★ A DIFFERENT PERMISSION FROM THE ROW IT ANNOTATES.
     *
     * The permissions list needs none; this needs
     * `analytics:dashboard:read`. So somebody can legitimately see what
     * GOTCHA may do and not see how often it has done it — which is a 403,
     * caught here like any other failure, and renders as the counts simply
     * not being there rather than as an error on a working screen.
     */
    api
      .get({ endpoint: analyticsEndpoints.toolUsage(), payload: toolUsageListSchema })
      .catch((cause: unknown) => {
        logger.warn('capabilities.usage_failed', { cause });
        return null;
      }),
  ]);

  return { capabilities, usage };
}
