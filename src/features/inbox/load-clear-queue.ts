import 'server-only';

import { serverApi } from '@/api/client/server-api';
import {
  analyticsOverviewSchema,
  inFlightSchema,
  type AnalyticsOverview,
  type InFlight,
} from '@/api/contracts/analytics';
import { analyticsEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * 02b's reads - only when the queue is clear, so an empty list never reads as
 * "the system stopped". Today's counts (Home's overview, the same range) and
 * what GOTCHA is in the middle of. Each is `null` when its read failed.
 */
export interface ClearQueue {
  readonly overview: AnalyticsOverview | null;
  readonly inFlight: InFlight | null;
}

export async function loadClearQueue(): Promise<ClearQueue> {
  const api = serverApi();
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const [overview, inFlight] = await Promise.all([
    api
      .get({
        endpoint: analyticsEndpoints.overview(),
        query: { from: start.toISOString(), to: now.toISOString() },
        payload: analyticsOverviewSchema,
      })
      .catch((cause: unknown) => {
        logger.warn('inbox.clear_overview_failed', { cause });
        return null;
      }),
    api
      .get({ endpoint: analyticsEndpoints.inFlight(), payload: inFlightSchema })
      .catch((cause: unknown) => {
        logger.warn('inbox.clear_in_flight_failed', { cause });
        return null;
      }),
  ]);
  return { overview, inFlight };
}
