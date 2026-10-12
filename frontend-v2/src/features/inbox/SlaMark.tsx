'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { SLA_TICK_MS, slaState, type SlaTarget } from './sla-clock';
import styles from './Inbox.module.css';

/**
 * One row's response-target mark (W2), recomputed every 30 seconds from the
 * row's own times - the list is not fetched again. It starts at the server's
 * `renderedAt`, so the first paint matches the server's, then reads the
 * device's clock.
 *
 * Late: a red dot that pulses (still, under reduced motion) and "Past SLA".
 * Close: a quiet amber chip with the minutes left. Otherwise nothing.
 */
export function SlaMark({
  target,
  renderedAt,
  testId,
}: {
  readonly target: SlaTarget;
  readonly renderedAt: string;
  readonly testId: string;
}) {
  const t = useTranslations('inbox.queue.sla');
  const [now, setNow] = useState(() => Date.parse(renderedAt));
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = window.setTimeout(tick, 0);
    const every = window.setInterval(tick, SLA_TICK_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(every);
    };
  }, []);

  const state = slaState(target, now);
  if (state.kind === 'none') return null;
  if (state.kind === 'warning') {
    return (
      <span
        className={styles.slaWarn}
        data-testid={testId}
        data-sla="warning"
        title={t('warningTitle', { minutes: target.minutes })}
      >
        {t('left', { count: state.minutesLeft })}
      </span>
    );
  }
  return (
    <span
      className={styles.slaLate}
      data-testid={testId}
      data-sla="late"
      title={t('lateTitle', { minutes: target.minutes })}
    >
      <span className={styles.slaDot} aria-hidden="true" />
      {t('late')}
    </span>
  );
}
