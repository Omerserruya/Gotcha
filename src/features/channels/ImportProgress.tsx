import { getLocale, getTranslations } from 'next-intl/server';

import {
  hasMeasuredAnything,
  isRunning,
  workDone,
  type ImportStatus,
} from '@/api/contracts/historical-import';

import styles from './Channels.module.css';

/**
 * Importing and learning — screen 13e.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THREE STATES, AND THE DESIGN'S FIVE NAMES AS PROSE
 * ════════════════════════════════════════════════════════════════════════════
 * The platform reports `transferring | analyzing | ready` (plus `failed` and
 * `unavailable`). The design draws five steps, and its last three are all
 * `analyzing`.
 *
 * Five segments where three flip together is worse than three honest ones:
 * simultaneity reads as *"those took no time"* rather than *"we cannot see
 * inside this"*, and a merchant has no way to tell which — so they draw the
 * flattering conclusion, which is the wrong one.
 *
 * The five names are genuinely more informative than the word "analyzing", so
 * they are kept as a sentence about what happens during that state, with a
 * second sentence saying they happen together. Same words, honest structure.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE WAIT IS FILLED WITH COUNTS, NOT FINDINGS
 * ════════════════════════════════════════════════════════════════════════════
 * `topTopics` is written at stage EIGHT OF NINE. Topics cannot fill the wait;
 * they end it, and showing them as "early findings" would claim a progressive
 * discovery that never happened.
 *
 * Counts do move, and the schema calls them *"counts of rows the pipeline
 * actually finished"* — so the screen says **read**, which is what they are.
 */
export async function ImportProgress({ status }: { readonly status: ImportStatus }) {
  const t = await getTranslations('channels.whatsapp');
  const locale = await getLocale();
  const n = new Intl.NumberFormat(locale);
  const done = workDone(status);

  return (
    <section className={styles.import} data-testid="import" data-stage={status.stage}>
      <h2 className={styles.sectionHeading}>{t('import.heading')}</h2>

      {/*
        First, because it is the anxiety this screen exists to remove. The
        number works already; none of this holds up a single message.
      */}
      <p className={styles.deliveryDetail} data-testid="import-live">
        {t('import.live')}
      </p>

      <p className={styles.delivery} data-testid="import-stage">
        {t(`import.stage.${status.stage}`)}
      </p>

      {status.stage === 'unavailable' ? (
        <p className={styles.deliveryDetail} data-testid="import-unavailable">
          {t('import.unavailableBody')}
        </p>
      ) : null}

      {status.stage === 'failed' ? (
        <p className={styles.templatesPausedReason} data-testid="import-failed">
          {/*
            `failedStage` when it is set. "Failed" alone tells a merchant
            nothing they can act on or repeat to support; the stage that broke
            is the difference between a dead end and a conversation.
          */}
          {status.failedStage
            ? t('import.failedWithStage', { stage: status.failedStage })
            : t('import.failedBare')}
        </p>
      ) : null}

      {status.stage === 'ready' ? (
        <p className={styles.deliveryDetail} data-testid="import-ready">
          {t('import.readyBody')}
        </p>
      ) : null}

      {isRunning(status) ? (
        <div data-testid="import-running">
          <p className={styles.deliveryDetail} data-testid="import-what-happens">
            {t('import.whatHappens')}
          </p>
          <p className={styles.checkDetail} data-testid="import-no-order">
            {t('import.noOrder')}
          </p>

          {/*
            Work done, as counts. A denominator of zero is not progress — it
            is a pipeline that has not started counting — so the ratio form
            is only used once there is one.
          */}
          {hasMeasuredAnything(status) ? (
            <ul className={styles.checks} data-testid="import-counts">
              <li className={styles.checkDetail} data-testid="import-conversations">
                {done.conversationsTotal
                  ? t('import.conversations', {
                      read: n.format(done.conversationsRead),
                      total: n.format(done.conversationsTotal),
                    })
                  : t('import.conversationsNoTotal', { read: n.format(done.conversationsRead) })}
              </li>
              {done.customersTotal ? (
                <li className={styles.checkDetail} data-testid="import-customers">
                  {t('import.customers', {
                    read: n.format(done.customersRead),
                    total: n.format(done.customersTotal),
                  })}
                </li>
              ) : null}
              <li className={styles.checkDetail} data-testid="import-answers">
                {t('import.answers', { count: done.answersFound })}
              </li>
            </ul>
          ) : (
            <p className={styles.checkDetail} data-testid="import-not-counted">
              {t('import.notCountedYet')}
            </p>
          )}

          <p className={styles.deliveryDetail} data-testid="import-safe-to-close">
            {t('import.safeToClose')}
          </p>
          {/*
            ★ THE EMAIL IS REAL AND THE NOTIFICATION IS NOT.
            `finalize.stage.ts` queues a completion email to every owner WITH
            an address, and nothing in it publishes an in-app notification —
            the only other signal is an operator log line. The design promises
            both; this promises the one that exists.

            And the condition is load-bearing: the code has a named branch for
            "no owner to notify", so a workspace whose owner has no address
            gets silence. Promising the email unconditionally would be false
            for a case the platform anticipated.
          */}
          <p className={styles.checkDetail} data-testid="import-email">
            {t('import.emailOnDone')} {t('import.emailNeedsAddress')}
          </p>
        </div>
      ) : null}
    </section>
  );
}
