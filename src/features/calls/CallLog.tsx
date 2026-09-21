import { getFormatter, getTranslations } from 'next-intl/server';

import {
  hasPlayableRecording,
  wasAnswered,
  type Call,
  type CallSummary,
} from '@/api/contracts/calls';

import styles from './Calls.module.css';

/**
 * Screen 05d — the call log.
 *
 * ── WHAT THE NUMBERS MEAN ──
 * The summary route answers `averageDurationMs: null` when nothing has a
 * duration, with `durationSampleSize` beside it, and its own comment says
 * why: *"'nobody connected' and 'calls averaged zero' are different
 * statements."* That is the same distinction as a send rate before anything
 * has been sent, arrived at independently on the backend — so the screen
 * honours it rather than rendering `0m 00s`.
 *
 * ── WHAT IS ABSENT ──
 * *"Ended in a sale · 18"* is `converted`, which is a concept nowhere in this
 * platform and is now its **fourth appearance across four screens**. The
 * *"Upset"* badge is sentiment — present on 9 of 89 conversations and 48+ days
 * old. *"Or have GOTCHA call a list"* has no model behind it at all.
 */
export async function CallLog({
  calls,
  summary,
}: {
  readonly calls: readonly Call[];
  readonly summary: CallSummary | null;
}) {
  const t = await getTranslations('calls');
  const format = await getFormatter();

  const duration = (ms: number | null) =>
    ms === null
      ? null
      : `${Math.floor(ms / 60000)}m ${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s`;

  return (
    <div className={styles.log} data-testid="call-log">
      {summary ? (
        <dl className={styles.summary} data-testid="call-summary">
          <div className={styles.stat}>
            <dt>{t('summary.total')}</dt>
            <dd>{format.number(summary.total)}</dd>
          </div>

          {/*
            An average with nothing behind it is not zero. The route sends
            `null` plus a sample size precisely so this can say "not yet"
            rather than "0m 00s" — which would read as calls that connected
            and lasted no time.
          */}
          <div className={styles.stat} data-testid="call-average">
            <dt>{t('summary.average')}</dt>
            <dd>
              {summary.averageDurationMs === null ? (
                <span className={styles.statUnknown}>{t('summary.noDurations')}</span>
              ) : (
                <>
                  {duration(summary.averageDurationMs)}
                  <span className={styles.statSample}>
                    {t('summary.fromSample', { count: summary.durationSampleSize })}
                  </span>
                </>
              )}
            </dd>
          </div>
        </dl>
      ) : null}

      <ul className={styles.calls}>
        {calls.map((call) => (
          <li key={call.id} className={styles.call} data-testid={`call-${call.id}`}>
            <span className={styles.callWho}>{call.customerNumber}</span>

            <span className={styles.callMeta}>
              {t(`direction.${call.direction}` as 'direction.inbound')}
              {/*
                `answeredAt`, not status: a call can be `completed` having
                never been answered — the provider completes it either way,
                and "it ended" is not "somebody spoke".
              */}
              {!wasAnswered(call) ? ` · ${t('unanswered')}` : null}
              {call.durationMs !== null ? ` · ${duration(call.durationMs)}` : null}
            </span>

            {/*
              A recording can fail on its own — `recordingStatus` is pending,
              available or failed. Offering a player for a recording that does
              not exist is a button that does nothing.
            */}
            {hasPlayableRecording(call) ? (
              <span className={styles.callHas} data-testid={`recording-${call.id}`}>
                {t('hasRecording')}
              </span>
            ) : call.recordingStatus === 'failed' ? (
              <span className={styles.callProblem} data-testid={`recording-failed-${call.id}`}>
                {t('recordingFailed')}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
