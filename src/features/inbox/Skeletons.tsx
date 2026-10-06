import type { ReactNode } from 'react';

import styles from './Inbox.module.css';

/**
 * The inbox's placeholders, in the shape of what they stand in for.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ OMER: "CONTENT PLACEHOLDERS" - AND THEY MUST NOT JUMP
 * ════════════════════════════════════════════════════════════════════════════
 * Each one is built to the real thing's measured box, so the content lands in
 * the space the placeholder held:
 *
 *   queue header   87   padding 18/18/12, a 16 title row, gap 12, a 28 filter row
 *   queue row      82   padding 13 16, a 42 disc, lines of 15 + 15 + 17 at gap 4
 *   conv. header   67   padding 16 22, a 34 disc, two lines
 *   composer card  86   1px #E6E2DA, radius 14
 *
 * They reuse the real containers' classes (`queueHeader`, `openBar`, …) for
 * the outer box, so a change to the real padding moves the placeholder too.
 *
 * ⚠ Their own module, with no server imports: `PendingPane` is a client
 *   component and draws these too.
 *
 * All `aria-hidden`: a screen reader is told the region is busy
 * (`aria-busy`) rather than read a column of empty shapes.
 */

/** The queue panel before its first read: header, filter row, rows. */
export function QueueSkeleton({ rows = 8 }: { readonly rows?: number }) {
  return (
    <div className={styles.queue} data-testid="queue-skeleton" aria-hidden="true">
      <div className={styles.queueHeader}>
        <div className={styles.queueTitleRow}>
          <span className={styles.skeletonLine} data-size="title" />
          <span className={styles.skeletonLine} data-size="count" />
        </div>
        <div className={styles.queueFilters}>
          <span className={styles.skeletonPill} />
          {[0, 1, 2, 3, 4].map((chip) => (
            <span key={chip} className={styles.skeletonChip} />
          ))}
        </div>
      </div>
      <div className={styles.queueScroll}>
        {Array.from({ length: rows }, (_, row) => (
          <QueueRowSkeleton key={row} />
        ))}
      </div>
    </div>
  );
}

/** One row: 82px, as the real row is with a preview and a tag line. */
export function QueueRowSkeleton() {
  return (
    <div className={styles.skeletonRow} data-testid="queue-row-skeleton">
      <span className={styles.skeletonDisc} data-size="42" />
      <span className={styles.skeletonLines}>
        <span className={styles.skeletonLine} data-size="name" />
        <span className={styles.skeletonLine} data-size="preview" />
        <span className={styles.skeletonLine} data-size="tag" />
      </span>
    </div>
  );
}

/**
 * The conversation panel: header, stream, composer, and the Copilot wall.
 *
 * `header` replaces the header's placeholder lines with something real - the
 * clicked row's name, which `PendingPane` already has.
 */
export function ConversationSkeleton({ header }: { readonly header?: ReactNode }) {
  return (
    <>
      <div className={styles.openBar} data-testid="header-skeleton">
        {header ?? (
          <div className={styles.openHeader}>
            <span className={styles.skeletonDisc} data-size="34" />
            <span className={styles.skeletonLines}>
              <span className={styles.skeletonLine} data-size="name" />
              <span className={styles.skeletonLine} data-size="facts" />
            </span>
          </div>
        )}
      </div>
      <div className={styles.chatBody}>
        <div className={styles.conversationPane}>
          <StreamSkeleton />
          <ComposerSkeleton />
        </div>
        <div className={styles.contextColumn}>
          <div className={styles.copilotBody}>
            <ContextSkeleton />
          </div>
        </div>
      </div>
    </>
  );
}

/** The stream's shape while it loads: bubbles on alternating sides. */
export function StreamSkeleton() {
  return (
    <div className={styles.streamSkeleton} data-testid="stream-skeleton" aria-hidden="true">
      <span className={styles.skeletonBubble} data-side="in" />
      <span className={styles.skeletonBubble} data-side="out" />
      <span className={styles.skeletonBubble} data-side="in" />
      <span className={styles.skeletonBubble} data-side="out" />
    </div>
  );
}

/** The composer card at its idle 86px. */
export function ComposerSkeleton() {
  return (
    <div className={styles.skeletonComposer} data-testid="composer-skeleton" aria-hidden="true" />
  );
}

/** The wall's shape while it loads. */
export function ContextSkeleton() {
  return (
    <div className={styles.contextSkeleton} data-testid="context-skeleton" aria-hidden="true">
      <span className={styles.skeletonLine} data-size="dark" />
      <span className={styles.skeletonLine} data-size="dark" />
      <span className={styles.skeletonBlock} />
    </div>
  );
}
