import { X } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';

import type { Notification } from '@/api/contracts/notifications';
import { Link } from '@/i18n/navigation';
import { safeInternalPath } from '@/lib/safe-url';

import { loadNotifications } from './load-notifications';
import { MarkAllRead, MarkRead } from './MarkAllRead';
import {
  groupOf,
  kindOf,
  type NotificationGroup,
  type NotificationKind,
} from './notification-kind';
import styles from './Notifications.module.css';

const GROUPS: readonly NotificationGroup[] = ['now', 'today', 'earlier'];

/**
 * 01d, measured: a 440 panel floating over Home - right 22, top 18 inside
 * the work surface, which fades behind it. Opened from the signals pill
 * (`/home?notifications=1`); `/notifications` lands here too.
 *
 *   head      "Notifications", "{n} new", Mark all read, Settings
 *   filters   Everything · Needs a decision · Broken - sorted by the
 *             catalogue's own event keys (`notification-kind.ts`)
 *   groups    NOW (the last hour) · EARLIER TODAY · EARLIER
 *   a row     a dot by priority, title, body, time; the one action - "Open
 *             it" where the link is ours - and "Mark read" while unread
 *   foot      no notification exists for an incoming message: the
 *             catalogue has no such event
 *
 * `link` is somebody's string, so it goes through `safeInternalPath`.
 * "Dismiss" is drawn as "Mark read": that is all the platform can do to a
 * notification - it has no dismissed state.
 */
export async function NotificationsPanel({
  kind = null,
  now = new Date(),
}: {
  readonly kind?: NotificationKind | null;
  readonly now?: Date;
}) {
  const t = await getTranslations('notifications');
  const format = await getFormatter();
  const { items, unread, failed } = await loadNotifications();
  const counts = {
    decision: items.filter((n) => kindOf(n) === 'decision').length,
    broken: items.filter((n) => kindOf(n) === 'broken').length,
  };
  const shown = kind ? items.filter((n) => kindOf(n) === kind) : items;
  const href = (k: NotificationKind | null) => ({
    pathname: '/home',
    query: k ? { notifications: '1', kind: k } : { notifications: '1' },
  });

  return (
    <div className={styles.layer} data-testid="notifications-panel">
      <Link
        href="/home"
        className={styles.scrim}
        aria-label={t('close')}
        tabIndex={-1}
        scroll={false}
      />
      <section className={styles.panel} aria-label={t('title')}>
        <header className={styles.head}>
          <h2 className={styles.title}>{t('title')}</h2>
          {unread > 0 ? (
            <span className={styles.new} data-testid="notifications-new">
              {t('new', { count: unread })}
            </span>
          ) : null}
          <span className={styles.headLinks}>
            {unread > 0 ? (
              <MarkAllRead label={t('markAllRead')} className={styles.headLink} />
            ) : null}
            <Link href="/settings/notifications" className={styles.headLink}>
              {t('settings')}
            </Link>
            <Link href="/home" className={styles.close} aria-label={t('close')} scroll={false}>
              <X size={14} aria-hidden="true" />
            </Link>
          </span>
        </header>

        <nav className={styles.filters} aria-label={t('filters')}>
          {([null, 'decision', 'broken'] as const).map((k) => (
            <Link
              key={k ?? 'all'}
              href={href(k)}
              className={styles.filter}
              aria-current={kind === k ? 'true' : undefined}
              data-testid={`notifications-filter-${k ?? 'all'}`}
              scroll={false}
            >
              {k === null
                ? t('filter.all')
                : counts[k] > 0
                  ? t('filter.counted', { name: t(`filter.${k}`), count: counts[k] })
                  : t(`filter.${k}`)}
            </Link>
          ))}
        </nav>

        <div className={styles.body}>
          {failed ? (
            <p className={styles.state} data-testid="notifications-failed">
              <span className={styles.stateTitle}>{t('failed.title')}</span>
              {t('failed.body')}
            </p>
          ) : shown.length === 0 ? (
            <p className={styles.state} data-testid="notifications-empty">
              <span className={styles.stateTitle}>
                {kind ? t(`emptyKind.${kind}`) : t('empty.title')}
              </span>
              {kind ? null : t('empty.body')}
            </p>
          ) : (
            GROUPS.map((group) => {
              const list = shown.filter((n) => groupOf(n, now) === group);
              return list.length === 0 ? null : (
                <section key={group} data-testid={`notifications-group-${group}`}>
                  <h3 className={styles.group}>{t(`group.${group}`)}</h3>
                  <ul className={styles.list} role="list">
                    {list.map((n) => (
                      <Row key={n.id} notification={n} time={time(n, now, format)} t={t} />
                    ))}
                  </ul>
                </section>
              );
            })
          )}
          <p className={styles.foot}>{t('foot')}</p>
        </div>
      </section>
    </div>
  );
}

/** "2m", "1h", "3d" - 02's mono column. */
function time(
  notification: Notification,
  now: Date,
  format: Awaited<ReturnType<typeof getFormatter>>,
): string {
  if (!notification.createdAt) return '';
  const at = new Date(notification.createdAt);
  if (Number.isNaN(at.getTime())) return '';
  const minutes = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h`;
  return format.dateTime(at, { day: 'numeric', month: 'short' });
}

function Row({
  notification,
  time,
  t,
}: {
  notification: Notification;
  time: string;
  t: Awaited<ReturnType<typeof getTranslations<'notifications'>>>;
}) {
  const href = safeInternalPath(notification.link);
  return (
    <li
      className={styles.row}
      data-read={notification.read ? 'yes' : 'no'}
      data-testid={`notification-${notification.id}`}
    >
      <span className={styles.dot} data-priority={notification.priority} aria-hidden="true" />
      <span className={styles.text}>
        <span className={styles.rowTitle}>
          {notification.title ?? notification.eventType ?? '-'}
        </span>
        {/*
          notifications 391c0a09: a body is "" when the title says it all -
          then nothing, not a blank line; nor for one of spaces.
        */}
        {notification.body?.trim() ? (
          <span className={styles.rowBody} data-testid={`notification-body-${notification.id}`}>
            {notification.body}
          </span>
        ) : null}
        {href || !notification.read ? (
          <span className={styles.actions}>
            {href ? (
              <Link
                href={href}
                className={styles.action}
                data-testid={`notification-open-${notification.id}`}
              >
                {t('open')}
              </Link>
            ) : null}
            {notification.read ? null : (
              <MarkRead id={notification.id} label={t('markRead')} className={styles.quiet} />
            )}
          </span>
        ) : null}
      </span>
      <span className={styles.time}>{time}</span>
    </li>
  );
}
