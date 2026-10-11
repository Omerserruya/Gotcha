import { Check } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';

import styles from './Inbox.module.css';
import type { ClearQueue } from './load-clear-queue';

/**
 * 02b, measured: the queue is clear - empty, but not blank.
 *
 * In the list: ✓, "The queue is clear", a line from today's counts, and
 * STILL GOING ON - what GOTCHA is in the middle of (live), and the two
 * kinds of nothing the platform does not record: items held by a broken
 * system, and conversations waiting on the customer. Both "-", with why.
 *
 * The foot says what the queue is: the route's default lists everything but
 * what an automation owns, so new conversations land here unless one is
 * running them - not "the moment GOTCHA needs a person".
 */
export async function ClearQueueList({ clear }: { readonly clear: ClearQueue }) {
  const t = await getTranslations('inbox.clear');
  const handled = clear.overview?.aiHandledCount ?? 0;
  return (
    <div className={styles.clear} data-testid="queue-clear">
      <div className={styles.clearHead}>
        <span className={styles.clearTile} aria-hidden="true">
          <Check size={20} />
        </span>
        <p className={styles.clearTitle}>{t('title')}</p>
        <p className={styles.clearLine} data-testid="queue-clear-line">
          {clear.overview && handled > 0
            ? `${t('answered', { count: handled })} ${t('anything')}`
            : t('anything')}
        </p>
      </div>
      <div className={styles.going}>
        <p className={styles.goingTitle}>{t('going')}</p>
        <ul className={styles.goingList}>
          <li className={styles.goingRow} data-testid="going-live">
            <span className={styles.goingDot} data-kind="live" aria-hidden="true" />
            <span className={styles.goingText}>
              {clear.inFlight
                ? clear.inFlight.conversationsHandling > 0
                  ? t('on', { count: clear.inFlight.conversationsHandling })
                  : t('onNone')
                : '-'}
            </span>
            {clear.inFlight && clear.inFlight.conversationsHandling > 0 ? (
              <span className={styles.goingMeta}>{t('live')}</span>
            ) : null}
          </li>
          <li className={styles.goingRow} title={t('heldNone')} data-testid="going-held">
            <span className={styles.goingDot} data-kind="held" aria-hidden="true" />
            <span className={styles.goingText}>{t('held')} -</span>
          </li>
          <li className={styles.goingRow} title={t('waitingNone')} data-testid="going-waiting">
            <span className={styles.goingDot} aria-hidden="true" />
            <span className={styles.goingText}>{t('waiting')} -</span>
          </li>
        </ul>
      </div>
    </div>
  );
}

/**
 * The right pane with nothing open: "Nothing to read", a sentence only as
 * strong as today's counts, what to do instead, and the day's numbers.
 */
export async function ClearQueuePane({ clear }: { readonly clear: ClearQueue }) {
  const t = await getTranslations('inbox.clear');
  const format = await getFormatter();
  const o = clear.overview;
  const nothingToday = !o || o.totalConversations === 0;
  const allAlone = o !== null && o.totalConversations > 0 && o.humanHandledCount === 0;
  const seconds = o?.avgResponseTimeMs != null ? Math.round(o.avgResponseTimeMs / 1000) : null;

  return (
    <div className={styles.clearPane} data-testid="nothing-to-read">
      <div className={styles.clearPaneBody}>
        <p className={styles.clearPaneTitle}>{t('nothing')}</p>
        <p className={styles.clearPaneLine} data-testid="nothing-line">
          {allAlone ? t('allAlone') : t('nothingWaiting')}
        </p>
        <div className={styles.clearPaneActions}>
          <Link
            href={{ pathname: '/inbox', query: { view: 'gotcha' } }}
            className={styles.clearPrimary}
            data-testid="see-answered"
          >
            {t('seeAnswered')}
          </Link>
          <span
            role="button"
            className={styles.clearSecondary}
            aria-disabled="true"
            title={t('writeNotYet')}
            data-testid="write-customer"
          >
            {t('write')}
          </span>
        </div>
      </div>
      <dl className={styles.clearStrip} data-testid="clear-strip">
        <div className={styles.clearCell}>
          <dt>{t('stat.answered')}</dt>
          <dd>{nothingToday ? '-' : format.number(o.aiHandledCount)}</dd>
        </div>
        <div className={styles.clearCell}>
          <dt>{t('stat.reply')}</dt>
          <dd>
            {seconds === null
              ? '-'
              : seconds < 60
                ? t('stat.seconds', { count: seconds })
                : t('stat.minutes', { count: Math.round(seconds / 60) })}
          </dd>
        </div>
        <div className={styles.clearCell}>
          <dt>{t('stat.passed')}</dt>
          <dd>{nothingToday ? '-' : format.number(o.humanHandledCount)}</dd>
        </div>
        <div className={styles.clearCellNote} title={t('stat.whyNone')}>
          -
        </div>
      </dl>
    </div>
  );
}
