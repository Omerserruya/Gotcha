import { getTranslations } from 'next-intl/server';

import { queueOrder, waitingMinutes, type ConversationRow } from '@/api/contracts/inbox';

import styles from './Inbox.module.css';

/**
 * Screen 02's queue.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ ONE PAGE, AND NO SCROLL, UNTIL THE KEYSET ENDPOINT EXISTS
 * ════════════════════════════════════════════════════════════════════════════
 * The list endpoint paginates by `page + limit`. On a list ordered by
 * recency that is the worst case for offset: a new message reorders rows
 * between page 1 and page 2, so an agent scrolling sees a duplicate and
 * **silently skips a row.**
 *
 * A skipped conversation in an inbox is not cosmetic — it is somebody
 * waiting who never appears, with no symptom the agent could notice. The
 * queue is the one list in this product where completeness IS the feature.
 *
 * Deduplicating by id was the obvious workaround and is worse: it hides the
 * duplicate and **not** the skip, removing the only visible tell of an
 * invisible fault. **Do not suppress the artefact you would have used to
 * detect the problem.**
 *
 * So: the most recent N, captioned as exactly that, and no promise that the
 * rest are reachable.
 *
 * ── AND THE ORDERING IS WORTH LESS THAN IT LOOKS ──
 * `lastMessageAt` is a denormalised cache maintained by convention across
 * ten call sites, with writers that bypass it. The caption does not promise
 * more ordering than that column can carry, and rows that admit they do not
 * know get their own group rather than the floor of the list.
 */
export async function ConversationList({
  rows,
  cap,
  now,
  hasMore,
}: {
  /** `null` when the read failed. Never an empty queue. */
  readonly rows: readonly ConversationRow[] | null;
  /** How many the page holds. Stated on screen, not implied. */
  readonly cap: number;
  readonly now: Date;
  /**
   * Whether the server says more pages exist.
   *
   * ★ IT DECIDES WHAT THE UNDATED GROUP CAN CLAIM. Undated rows sort last,
   * so only on the final page is "these are the undated ones" a statement
   * about the queue rather than about this page.
   */
  readonly hasMore: boolean;
}) {
  const t = await getTranslations('inbox');

  if (rows === null) {
    return (
      <div className={styles.queue} data-testid="queue-unavailable">
        <p className={styles.note}>{t('queue.unavailable')}</p>
      </div>
    );
  }

  const { dated, undated } = queueOrder(rows);

  const row = (conversation: ConversationRow, testid: string) => {
    const waiting = waitingMinutes(conversation, now);
    return (
      <li key={conversation.id} className={styles.queueRow} data-testid={testid}>
        <span className={styles.who}>{conversation.contactName ?? t('queue.unnamed')}</span>
        <span className={styles.channel}>{conversation.channel ?? t('queue.unknownChannel')}</span>
        {/*
          ★ NULL IS NOT ZERO. A row we cannot age says nothing rather than
          claiming it has been waiting no time at all, which would sort it
          alongside the freshest thing in the queue.
        */}
        {waiting === null ? null : (
          <span className={styles.waiting} data-testid={`waiting-${conversation.id}`}>
            {t('queue.waiting', { minutes: waiting })}
          </span>
        )}
      </li>
    );
  };

  return (
    <div className={styles.queue} data-testid="conversation-list">
      {/*
        ★★ THE CAP IS STATED, NOT IMPLIED. A list that stops at N and says
        nothing teaches an agent that N is all there is.
      */}
      <p className={styles.note} data-testid="queue-cap">
        {hasMore ? t('queue.cap', { count: cap }) : t('queue.capAll', { count: rows.length })}
      </p>

      {dated.length === 0 && undated.length === 0 ? (
        <p className={styles.note} data-testid="queue-empty">
          {t('queue.empty')}
        </p>
      ) : (
        <ol className={styles.queueList}>{dated.map((c) => row(c, `conversation-${c.id}`))}</ol>
      )}

      {/*
        ════════════════════════════════════════════════════════════════════
        ★★ THE ROWS THE ORDERING CANNOT PLACE, SHOWN RATHER THAN SUNK
        ════════════════════════════════════════════════════════════════════
        `lastMessageAt` is maintained by convention and some writers skip it.
        A null sinks to the floor of a recency list and is never seen — the
        same defect as the pagination skip, and the reason this list is
        capped in the first place.

        Its own group says the true thing: open, and we cannot tell where
        they belong. The count makes a growing problem visible instead of
        gradual — if writers that forget are common, that number rising is
        how anybody would ever find out, and it rises in front of the person
        using the screen rather than only in an audit.

        ════════════════════════════════════════════════════════════════════
        ⚠ AND THIS COVERS THE VISIBLE TENTH OF THE PROBLEM
        ════════════════════════════════════════════════════════════════════
        **We can refuse to bury the rows that ADMIT they do not know. We
        cannot find the ones that are quietly wrong.** A stale
        `lastMessageAt` — a plausible timestamp from before the newest
        message, written by a forgetful path — is indistinguishable from a
        correct one at every layer we control. Nothing on the row disagrees
        with it and the list looks entirely normal.

        This is written here rather than only in a message because **a
        partial fix that looks complete is how a known problem stops being
        tracked**, and this one is shaped to look complete: a named group, a
        count, a true sentence, all correct, covering the minority case.

        The majority case is with the write-path audit and is not solvable
        from this file.

        ════════════════════════════════════════════════════════════════════
        ⚠ AND THE GROUP ITSELF IS PER PAGE, BECAUSE NULLS SORT LAST
        ════════════════════════════════════════════════════════════════════
        The server orders `{ lastMessageAt: desc, nulls: last }`, so every
        undated row sits at the **very end of the whole queue**. On a tenant
        with more conversations than one page holds, this group is empty on
        every page but the last — and an empty group reads as "none".

        Found when the keyset endpoint landed and made the paging real. It
        was already true of the capped list and I had not seen it: the group
        I built to make a hidden problem visible was itself hidden by the
        ordering, for exactly the tenants with enough conversations to have
        the problem.

        So the caption says which it is. A whole-queue count needs an
        endpoint nobody offers yet.
      */}
      {undated.length > 0 ? (
        <section data-testid="queue-undated">
          <p className={styles.note}>
            {hasMore
              ? t('queue.undatedThisPage', { count: undated.length })
              : t('queue.undated', { count: undated.length })}
          </p>
          <ol className={styles.queueList}>{undated.map((c) => row(c, `undated-${c.id}`))}</ol>
        </section>
      ) : null}
    </div>
  );
}
