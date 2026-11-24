'use client';

import { UNREAD_BADGE_MAX, type UnreadMark } from '@/api/contracts/inbox';
import { useReadOverride } from '@/features/inbox/RowDelete';

import styles from './mobile-inbox.module.css';

/**
 * The row's unread mark: the server's, unless a swipe has just set one
 * (`useReadOverride`, RowDelete) - then the row turns at once, before the
 * list's refresh brings the server's answer.
 *
 *   swiped unread, nothing counted   a dot (the server draws a manual mark so)
 *   swiped unread, already counted   the count, unchanged
 *   swiped read                      nothing
 */
export function RowUnreadMark({
  mark,
  unreadLabel,
  countLabel,
}: {
  readonly mark: UnreadMark | null;
  /** "Unread", for a screen reader, on the dot. */
  readonly unreadLabel: string;
  /** "3 unread messages", for a screen reader, on the count. `null` with no count. */
  readonly countLabel: string | null;
}) {
  const override = useReadOverride();
  const shown: UnreadMark | null =
    override === false ? null : override === true && mark === null ? { kind: 'dot' } : mark;

  if (shown === null) return null;
  if (shown.kind === 'count') {
    return (
      <span className={styles.badge}>
        {/* "99+" is a number: kept left-to-right, or Hebrew draws "+99". */}
        <span aria-hidden="true" dir="ltr">
          {shown.count > UNREAD_BADGE_MAX ? `${UNREAD_BADGE_MAX}+` : shown.count}
        </span>
        <span className="srOnly">{countLabel}</span>
      </span>
    );
  }
  return (
    <span className={styles.dot} data-testid="row-unread-dot">
      <span className="srOnly">{unreadLabel}</span>
    </span>
  );
}
