import 'server-only';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { parseUnreadCounts, unreadCountsSchema } from '@/api/contracts/inbox';
import { inboxEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

import { INBOX_VIEW_IDS, type InboxView } from './inbox-views';

export type UnreadCounts = Partial<Record<InboxView, number>>;

/**
 * How many conversations are unread for the person looking, per view - or
 * `null` when nobody said.
 *
 * ⚠⚠ THE ROUTE IS AGREED AND NOT YET DEPLOYED (see the registry). Until it
 *    is, this answers 404 on every inbox render, and that is the ordinary
 *    case rather than a fault: it is logged at debug, and the rail draws no
 *    count. Only `InboxView` ids are sent - the route 400s an unknown one. Never a 0 - a 0 would say "nothing unread" on a service that
 *    cannot count.
 */
export async function loadUnreadCounts(): Promise<UnreadCounts | null> {
  try {
    const body = await serverApi().get({
      endpoint: inboxEndpoints.unreadCounts(),
      query: { views: INBOX_VIEW_IDS.join(',') },
      payload: unreadCountsSchema,
    });
    return parseUnreadCounts(body, INBOX_VIEW_IDS);
  } catch (cause) {
    if (isApiError(cause) && cause.status === 404) {
      logger.debug('inbox.unread_counts_absent');
    } else {
      logger.warn('inbox.unread_counts_failed', { cause });
    }
    return null;
  }
}
