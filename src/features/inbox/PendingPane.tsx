'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

import { ConversationSkeleton } from './Skeletons';
import { initials } from './initials';
import { clearPendingOpen, usePendingOpen } from './pending-open';
import styles from './Inbox.module.css';

/**
 * What the conversation panel shows between a click and the server's answer.
 *
 * Over the panel, not in it: the header and the stream of the conversation
 * being LEFT stay mounted underneath, so nothing is torn down for a click
 * that might still be followed by another. The overlay draws the clicked
 * row's name and channel — already on the row — and the stream's skeleton.
 *
 * ★ CLEARED BY THE ANSWER — the URL landing, not only the open conversation
 *   changing. If the server answers with the SAME open conversation (the one
 *   clicked has gone, and the first row is open again), `openId` does not
 *   change, and keyed on it alone the overlay would stay up for good. The
 *   search params change with every navigation that lands.
 */
export function PendingPane({ openId }: { readonly openId: string | null }) {
  const pending = usePendingOpen();
  const landed = useSearchParams()?.toString() ?? '';

  useEffect(() => {
    clearPendingOpen();
  }, [openId, landed]);

  if (pending === null || pending.id === openId) return null;

  return (
    <div className={styles.pendingPane} data-testid="pending-pane" aria-busy="true">
      <ConversationSkeleton
        header={
          <div className={styles.openHeader}>
            <span className={styles.openAvatar} aria-hidden="true">
              {initials(pending.name)}
            </span>
            <div className={styles.openWho}>
              <p className={styles.openName}>{pending.name}</p>
              {pending.channelLabel ? (
                <p className={styles.openFacts}>{pending.channelLabel}</p>
              ) : null}
            </div>
          </div>
        }
      />
    </div>
  );
}
