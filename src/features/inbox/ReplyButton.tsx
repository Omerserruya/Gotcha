'use client';

import { replyTo, type ReplyTarget } from './reply-event';
import styles from './Inbox.module.css';

/**
 * 02's hover bar, with the one action in it that has a backend.
 *
 * 02 draws Ask Copilot · Reply · React · Save as knowledge. Reply is
 * `replyToMessageId` on the send route, and the quote block already draws
 * what it produces. React has no outbound adapter; the other two belong to
 * the Copilot. A bar of one is still 02's bar.
 *
 * The words come from the server, which renders the stream — this component
 * only carries them, so it needs no translations of its own.
 */
export function ReplyButton({
  target,
  label,
  description,
}: {
  readonly target: ReplyTarget;
  /** "Reply". */
  readonly label: string;
  /** "Reply to this message", for whoever cannot see which one the bar is on. */
  readonly description: string;
}) {
  return (
    <span className={styles.messageActions}>
      <button
        type="button"
        className={styles.messageAction}
        data-testid={`reply-${target.id}`}
        aria-label={description}
        onClick={() => replyTo(target)}
      >
        {label}
      </button>
    </span>
  );
}
