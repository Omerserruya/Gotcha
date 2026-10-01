import { getTranslations } from 'next-intl/server';

import {
  channelName,
  queueOrder,
  waitingMinutes,
  waitingScale,
  type ConversationRow,
} from '@/api/contracts/inbox';

import styles from './Inbox.module.css';
import { UserText } from '@/design-system/primitives/text/UserText';
import { Link } from '@/i18n/navigation';

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
  undatedCount,
  openId,
}: {
  /** `null` when the read failed. Never an empty queue. */
  readonly rows: readonly ConversationRow[] | null;
  /**
   * The conversation currently open, so its row can say so.
   *
   * ⚠ In the capture, the open conversation's row was VISUALLY IDENTICAL to
   *   the other nine. A queue that cannot show you where you are is a list
   *   you have to re-read after every reply.
   */
  readonly openId?: string | null;
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
  /**
   * Undated conversations across the whole view, cursor-blind.
   *
   * ★ `undefined` MEANS NOBODY LOOKED. The running service may predate the
   * count, or the read may have failed. Either way the screen must not say
   * zero — that is the instrument reporting all-clear because it is absent.
   */
  readonly undatedCount?: number;
}) {
  const t = await getTranslations('inbox');
  /*
   * The channel labels live in `channels`, where screen 13 already maintains
   * them in both languages. Reading them from there rather than copying ten
   * names into `inbox` keeps one set of words for one set of things.
   */
  const channelNames = await getTranslations('channels');

  if (rows === null) {
    return (
      <div className={styles.queue} data-testid="queue-unavailable">
        <p className={styles.note}>{t('queue.unavailable')}</p>
      </div>
    );
  }

  const { dated, undated } = queueOrder(rows);

  /*
   * ★ A COUNT WITH NO ROWS ON THIS PAGE IS STILL WORTH SAYING.
   *
   * Undated rows sort last, so on any page but the final one the count can
   * be non-zero while this page holds none of them. That is exactly the
   * case the count was added for, and hiding the group because the page is
   * clean would reinstate the defect it fixes.
   */
  const showUndated = undated.length > 0 || (undatedCount !== undefined && undatedCount > 0);

  const row = (conversation: ConversationRow, testid: string) => {
    const waiting = waitingMinutes(conversation, now);
    return (
      <li key={conversation.id} className={styles.queueItem}>
        {/*
          ════════════════════════════════════════════════════════════════════
          ⚠⚠ THE ROWS WERE NOT CLICKABLE. AT ALL.
          ════════════════════════════════════════════════════════════════════
          Measured on the deployed build: a `DIV`, no role, no tabindex, zero
          links or buttons inside, `cursor: auto`, no hover, and nothing on
          right-click. **The only way into a conversation was to type
          `?c=<id>` in the address bar** — on the screen whose entire job is
          choosing which conversation to open.

          ★ A LINK, NOT THE DESIGN'S `<button onClick>`. The prototype uses a
            button because a static mock has no routing; we have a real URL.
            An anchor gives middle-click, open-in-new-tab, the browser's own
            context menu, keyboard focus and a status-bar preview — all of
            which a button reimplements badly or not at all. That is the same
            reading as the code field's caret: when the mock draws something
            the platform provides, it is describing an outcome.

          ⚠ AND THE PARAMETER IS `c`, NOT `conversation`. The only reader is
            `inbox/page.tsx`, which destructures `c`. A walk URL quoted
            `?conversation=` and it was the harness's, not ours.
        */}
        <Link
          href={{ pathname: '/inbox', query: { c: conversation.id } }}
          className={styles.queueRow}
          data-testid={testid}
          aria-current={conversation.id === openId ? 'true' : undefined}
          data-open={conversation.id === openId ? '' : undefined}
        >
          {/*
          ★★ THE CUSTOMER'S NAME, WHICH WAS "Someone" ON EVERY ROW.
          The contract named a field the platform does not send, so the real
          `customerName` was stripped and the invented one defaulted to null.
          Ten of ten rows in the capture read the fallback, and it looked like
          the security fixtures redacting.
        */}
          <span className={styles.who}>
            {conversation.customerName === null ? (
              t('queue.unnamed')
            ) : (
              /* A name is the data's direction, not the layout's. */
              <UserText>{conversation.customerName}</UserText>
            )}
          </span>
          {/*
          ★★ THE CHANNEL'S NAME, NOT ITS ENUM. `SHOPIFY_LIVE_CHAT` was on
          screen; `channels.name.SHOPIFY_LIVE_CHAT` has said "Shopify live
          chat" in both languages all along.

          An unrecognised value gets "another channel" rather than its raw
          string: `channel` is an unconstrained column, every other screen
          here strips raw identifiers, and an agent cannot act on an enum name.
        */}
          <span className={styles.channel}>
            {/*
            Three states through one helper. `channelName` returns `null` only
            for an absent channel — a recognised one gets its name and an
            unrecognised one gets "another channel" — so the distinction this
            row needs is the distinction the helper already draws.

            This used `channels.name.other` under a local key of its own; the
            two said the same thing in two places, which is one of them too many.
          */}
            {channelName(conversation.channel, channelNames) ?? t('queue.unknownChannel')}
          </span>
          {/*
          ★ NULL IS NOT ZERO. A row we cannot age says nothing rather than
          claiming it has been waiting no time at all, which would sort it
          alongside the freshest thing in the queue.
        */}
          {waiting === null ? null : (
            <span className={styles.waiting} data-testid={`waiting-${conversation.id}`}>
              {/*
              ★★ AT A SCALE SOMEBODY CAN READ. This printed raw minutes, so
              the capture showed `47061m` — thirty-two days, on the column an
              agent triages on, and illegible enough to be reported as a
              possible identifier.
            */}
              {(() => {
                const { scale, value } = waitingScale(waiting);
                return t(`queue.waitingFor.${scale}` as 'queue.waitingFor.minutes', { value });
              })()}
            </span>
          )}
        </Link>
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
      {showUndated ? (
        <section data-testid="queue-undated">
          {/*
            ★★ THE VIEW-WIDE COUNT SUPERSEDES THE PER-PAGE ONE.

            `undatedCount` is scoped to this view's filters and is
            cursor-blind, so it answers the question the per-page group could
            only gesture at. When it is absent — an older service, or a
            failed read — the caption falls back to what this page can see
            and says that is what it is.
          */}
          <p className={styles.note}>
            {undatedCount !== undefined
              ? t('queue.undatedInView', { count: undatedCount })
              : hasMore
                ? t('queue.undatedThisPage', { count: undated.length })
                : t('queue.undated', { count: undated.length })}
          </p>
          <ol className={styles.queueList}>{undated.map((c) => row(c, `undated-${c.id}`))}</ol>
        </section>
      ) : null}
    </div>
  );
}
