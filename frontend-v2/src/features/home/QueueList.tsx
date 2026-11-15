import { getTranslations } from 'next-intl/server';

import type { QueueItem } from '@/api/contracts/analytics';
import { Link } from '@/i18n/navigation';

import styles from './Home.module.css';
import { initials, TONE_BY_INTENT, waitLabel } from './queue-row';
import { channelName } from '@/api/contracts/inbox';
import { UserText } from '@/design-system/primitives/text/UserText';
import { PersonName } from '@/features/customers/PersonName';

/**
 * "Needs you now" - the ranked queue on Home.
 *
 * Ordered by risk, not by time, and the order is the server's. Recomputing it
 * here would mean Home and Inbox disagreeing about the first row the moment
 * either changed, and an operator who sees that stops trusting both.
 *
 * A row opens the conversation in Inbox, as the design states.
 */

const ROW_TONE_CLASS = {
  urgent: styles.queueRowUrgent,
  opportunity: styles.queueRowOpportunity,
  blocked: styles.queueRowBlocked,
} as const;

const CHIP_TONE_CLASS = {
  urgent: styles.queueChipUrgent,
  opportunity: styles.queueChipOpportunity,
  blocked: styles.queueChipBlocked,
} as const;

/** The intents that have their own wording. Anything else falls back. */
const LABELLED_INTENTS = new Set([
  'FRUSTRATED',
  'COMPLAINT',
  'HIGH_INTENT',
  'REFUND',
  'SHIPPING_ISSUE',
  'RETURN',
  'ORDER_CHANGE',
  'PRODUCT_QUESTION',
  'WAITING_EXTERNAL',
  'OTHER',
]);

/**
 * A row of the card: a ranked queue item, or - in a one-person workspace -
 * an open conversation (`openItem`), which has no intent and no wait the
 * ranker measured. `null` draws no chip and no age, never an invented one.
 */
export type NeedsYouItem = Pick<
  QueueItem,
  'conversationId' | 'customer' | 'channel' | 'preview'
> & {
  readonly intent: string | null;
  readonly waitingSince: string | null;
};

export async function QueueList({
  items,
  totalWaiting,
  now,
  of = 'queue',
}: {
  items: readonly NeedsYouItem[];
  totalWaiting: number;
  /**
   * What the card lists: the ranked queue, or one person's open
   * conversations (Omer, 2026-11-15) - whose footer opens "Open", and whose
   * words say open, not waiting.
   */
  of?: 'queue' | 'open';
  /**
   * The instant the page was rendered, decided once by the screen and passed
   * down. Reading the clock here would make this component impure, and every
   * row would also be measured against a slightly different "now".
   */
  now: Date;
}) {
  const t = await getTranslations('home.needsYou');
  /* The channel labels screen 13 already maintains, in both languages. */
  const channelNames = await getTranslations('channels');
  // An open conversation with neither a name nor a handle reads as the inbox reads it.
  const inbox = await getTranslations('inbox');
  const remaining = Math.max(0, totalWaiting - items.length);

  return (
    <div className={styles.queueCard}>
      {items.map((item) => {
        const tone = item.intent === null ? undefined : TONE_BY_INTENT[item.intent];
        const intentKey =
          item.intent === null ? null : LABELLED_INTENTS.has(item.intent) ? item.intent : 'OTHER';

        return (
          <Link
            key={item.conversationId}
            // The inbox opens a conversation by `?c=` (it read nothing else, and these opened nothing).
            href={{ pathname: '/inbox', query: { c: item.conversationId } }}
            className={[styles.queueRow, tone ? ROW_TONE_CLASS[tone] : ''].join(' ').trim()}
          >
            <span className={styles.queueAvatar} aria-hidden="true">
              {initials(item.customer.name)}
            </span>

            <span className={styles.queueRowText}>
              <span className={styles.queueRowIdentity}>
                <span className={styles.queueRowName}>
                  {/*
                   * No name means no contact record. The channel identifier is
                   * shown as itself rather than dressed up as a name.
                   */}
                  {item.customer.name ? (
                    <PersonName name={item.customer.name} />
                  ) : (
                    item.customer.id || inbox('queue.unnamed')
                  )}
                </span>
                {/*
                  ★★ THE CHANNEL'S NAME, ON EVERY ROW OF THE FIRST SCREEN.
                  This printed `SHOPIFY_LIVE_CHAT` verbatim. Same fix as the
                  inbox queue and the metric strip, and this site was missed by
                  `raw-value-sweep` because the line also assigns a className -
                  the blind spot that script now documents. A browser walk
                  found it.
                */}
                <span className={styles.queueRowChannel}>
                  {channelName(item.channel, channelNames) ?? channelNames('name.other')}
                </span>
              </span>
              <span className={styles.queueRowPreview}>
                <UserText>{item.preview}</UserText>
              </span>
            </span>

            {intentKey === null ? null : (
              <span
                className={[styles.queueChip, tone ? CHIP_TONE_CLASS[tone] : ''].join(' ').trim()}
              >
                {t(`intent.${intentKey}`)}
              </span>
            )}

            <span className={styles.queueWait}>
              {item.waitingSince === null ? '' : waitLabel(item.waitingSince, now.getTime(), t)}
            </span>
          </Link>
        );
      })}

      {remaining > 0 ? (
        <Link
          // The rest of the QUEUE: named, since a bare /inbox is "Assigned to me".
          href={{ pathname: '/inbox', query: { view: of } }}
          className={styles.queueFooter}
        >
          {t(of === 'open' ? 'open.more' : 'more', { count: remaining })}
        </Link>
      ) : null}
    </div>
  );
}
