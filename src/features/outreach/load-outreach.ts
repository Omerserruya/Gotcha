import 'server-only';

import { serverApi } from '@/api/client/server-api';
import { campaignsSchema, isInFlight, type Campaign } from '@/api/contracts/outreach';
import { outreachEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * What screens 05 and 05b read.
 *
 * `GET /api/broadcasts` is `{ data }` enveloped and returns the tenant's
 * campaigns. The split into in-flight and finished happens here rather than in
 * two calls: the route takes no status filter, so asking twice would fetch the
 * same rows twice and could disagree with itself between the two responses.
 *
 * `null` is a failed read and is never conflated with an empty list. On this
 * screen the difference is the whole first paragraph: no campaigns means
 * nothing has been sent, a failed read means you do not know whether anything
 * is going out right now.
 */
export interface OutreachData {
  readonly inFlight: readonly Campaign[] | null;
  readonly finished: readonly Campaign[] | null;
  /** True when the read failed. Both lists are null in that case. */
  readonly unavailable: boolean;
}

export async function loadOutreach(): Promise<OutreachData> {
  try {
    const campaigns = await serverApi().get({
      endpoint: outreachEndpoints.list(),
      payload: campaignsSchema,
    });

    return {
      inFlight: campaigns.filter(isInFlight),
      // Everything that is no longer going anywhere — completed, cancelled,
      // failed and drafts. Newest first by whatever ended them.
      finished: campaigns
        .filter((c) => !isInFlight(c))
        .sort(
          (a, b) =>
            Date.parse(b.completedAt ?? b.createdAt) - Date.parse(a.completedAt ?? a.createdAt),
        ),
      unavailable: false,
    };
  } catch (cause) {
    logger.warn('outreach.list_failed', { cause });
    return { inFlight: null, finished: null, unavailable: true };
  }
}
