import 'server-only';

import {
  notificationPageSchema,
  unreadCountSchema,
  type Notification,
} from '@/api/contracts/notifications';
import { notificationEndpoints } from '@/api/endpoints/registry';
import { serverApi } from '@/api/client/server-api';
import { logger } from '@/observability/logger';

export interface NotificationsData {
  readonly items: readonly Notification[];
  readonly nextCursor: string | null;
  readonly unread: number;
  readonly failed: boolean;
}

/**
 * The notification list and its unread count.
 *
 * `raw` on the list because the page is `{ data, nextCursor }` - `data` sits
 * beside the cursor rather than wrapping it, so unwrapping would silently
 * throw pagination away.
 */
export async function loadNotifications(cursor?: string): Promise<NotificationsData> {
  const api = serverApi();

  const [page, count] = await Promise.all([
    api
      .get({
        endpoint: notificationEndpoints.list(),
        query: { limit: 50, ...(cursor ? { cursor } : {}) },
        payload: notificationPageSchema,
        raw: true,
      })
      .catch((cause: unknown) => {
        logger.warn('notifications.list_failed', { cause });
        return null;
      }),
    api
      .get({ endpoint: notificationEndpoints.unreadCount(), payload: unreadCountSchema, raw: true })
      .catch(() => null),
  ]);

  return {
    items: page?.data ?? [],
    nextCursor: page?.nextCursor ?? null,
    unread: count?.count ?? 0,
    failed: page === null,
  };
}
