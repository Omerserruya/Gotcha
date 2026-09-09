import { getFormatter, getTranslations } from 'next-intl/server';

import type { Notification } from '@/api/contracts/notifications';
import { StateDisplay } from '@/design-system/patterns/StateDisplay';
import { Text } from '@/design-system/primitives/text/Text';
import { Link } from '@/i18n/navigation';
import { safeInternalPath } from '@/lib/safe-url';

import { loadNotifications } from './load-notifications';
import { MarkAllRead } from './MarkAllRead';
import styles from './Notifications.module.css';

/**
 * Notifications — screen 01c.
 *
 * "Six a day, every one of them a decision or a failure." The design's premise
 * is that this is signal, not a feed, so the list is chronological and plain
 * and the only ranking device is a priority edge.
 *
 * Two things about the data shape drive the code:
 *
 *   - **`eventType` is not an enum.** It is a free-text column written through
 *     from whatever produced the event, and none of the types the brief names
 *     are actually emitted. So nothing branches on it. `priority` is a real
 *     enum and is what the interface uses.
 *   - **`link` is free text**, with no typed ids behind it. It is somebody's
 *     string, so it goes through `safeInternalPath` before it becomes an
 *     `href` — otherwise a stored value could turn this list into an open
 *     redirect.
 */
export async function NotificationsScreen() {
  const t = await getTranslations('notifications');
  const format = await getFormatter();
  const { items, unread, failed } = await loadNotifications();

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <Text role="title" as="h1">
            {t('title')}
          </Text>
          <Text role="body" tone="muted">
            {unread > 0 ? t('unread', { count: unread }) : t('allRead')}
          </Text>
        </div>
        {unread > 0 ? <MarkAllRead label={t('markAllRead')} /> : null}
      </div>

      {failed ? (
        <StateDisplay tone="danger" title={t('failed.title')} description={t('failed.body')} />
      ) : items.length === 0 ? (
        // Not an error and not a blank panel: an empty list here means the
        // product is working, and the design says zero states are worth
        // designing rather than apologising for.
        <StateDisplay title={t('empty.title')} description={t('empty.body')} />
      ) : (
        <ul className={styles.list} role="list">
          {items.map((item) => (
            <NotificationRow key={item.id} notification={item} formattedTime={time(item, format)} />
          ))}
        </ul>
      )}
    </div>
  );
}

function time(
  notification: Notification,
  format: Awaited<ReturnType<typeof getFormatter>>,
): string {
  if (!notification.createdAt) return '';
  const at = new Date(notification.createdAt);
  return Number.isNaN(at.getTime()) ? '' : format.relativeTime(at);
}

function NotificationRow({
  notification,
  formattedTime,
}: {
  notification: Notification;
  formattedTime: string;
}) {
  const href = safeInternalPath(notification.link);
  const tone = notification.priority.toLowerCase() as 'critical' | 'high' | 'medium' | 'low';

  return (
    <li
      className={[styles.item, styles[tone], notification.read ? undefined : styles.unread]
        .filter(Boolean)
        .join(' ')}
    >
      <span className={styles.itemBody}>
        {href ? (
          <Link href={href} className={styles.itemTitle}>
            {notification.title ?? notification.eventType ?? ''}
          </Link>
        ) : (
          <Text role="meta" as="span">
            {notification.title ?? notification.eventType ?? ''}
          </Text>
        )}
        {notification.body ? (
          <Text role="caption" tone="muted" as="span">
            {notification.body}
          </Text>
        ) : null}
      </span>
      <span className={styles.itemTime}>{formattedTime}</span>
    </li>
  );
}
