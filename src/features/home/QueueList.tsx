import { getTranslations } from 'next-intl/server';

import type { QueueItem } from '@/api/contracts/analytics';
import { Link } from '@/i18n/navigation';

import styles from './Home.module.css';
import { initials, waitLabel } from './queue-row';
import { channelName } from '@/api/contracts/inbox';
import { UserText } from '@/design-system/primitives/text/UserText';

/**
 * "Needs you now" - the ranked queue on Home.
 *
 * Ordered by risk, not by time, and the order is the server's. Recomputing it
 * here would mean Home and Inbox disagreeing about the first row the moment
 * either changed, and an operator who sees that stops trusting both.
 *
 * A row opens the conversation in Inbox, as the design states.
 */

/**
 * How an intent reads on the row.
 *
 * The design marks a row only when it is angry, valuable or blocked;
 * everything else is neutral. `COMPLAINT` joins `FRUSTRATED` because the
 * ranker weighs them identically, and an unrecognised intent is neutral rather
 * than guessed at - a wrongly coloured row is worse than an uncoloured one.
 */
const TONE_BY_INTENT: Record<string, 'urgent' | 'opportunity' | 'blocked'> = {
  FRUSTRATED: 'urgent',
  COMPLAINT: 'urgent',
  HIGH_INTENT: 'opportunity',
  WAITING_EXTERNAL: 'blocked',
};

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

export async function QueueList({
  items,
  totalWaiting,
  now,
}: {
  items: readonly QueueItem[];
  totalWaiting: number;
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
  const remaining = Math.max(0, totalWaiting - items.length);

  return (
    <div className={styles.queueCard}>
      {items.map((item) => {
        const tone = TONE_BY_INTENT[item.intent];
        const intentKey = LABELLED_INTENTS.has(item.intent) ? item.intent : 'OTHER';

        return (
          <Link
            key={item.conversationId}
            href={`/inbox?conversation=${encodeURIComponent(item.conversationId)}`}
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
                  {item.customer.name ?? item.customer.id}
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

            <span
              className={[styles.queueChip, tone ? CHIP_TONE_CLASS[tone] : ''].join(' ').trim()}
            >
              {t(`intent.${intentKey}`)}
            </span>

            <span className={styles.queueWait}>
              {waitLabel(item.waitingSince, now.getTime(), t)}
            </span>
          </Link>
        );
      })}

      {remaining > 0 ? (
        <Link href="/inbox" className={styles.queueFooter}>
          {t('more', { count: remaining })}
        </Link>
      ) : null}
    </div>
  );
}
