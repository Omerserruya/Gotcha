import { getLocale, getTranslations } from 'next-intl/server';

import type { Allowance } from '@/api/contracts/billing';

import styles from './Billing.module.css';

/**
 * *"Usage as runway, not credits."*
 *
 * The headline pairs what is left with the date it runs out at today's pace —
 * and **both numbers come from the server**. The route computes the projection
 * deliberately, because Home draws the same figure and two surfaces running
 * their own arithmetic would eventually disagree. When they disagree, neither
 * is believed again.
 *
 * ── THE STATE THE DESIGN DOES NOT DRAW ──
 * A plan can carry **no conversation allowance at all**: `limit` is null when
 * no volume option is selected, which is true of the demo tenant right now.
 * That is not zero and it is not unlimited — the plan simply does not meter
 * conversations.
 *
 * So there is no bar, no "1,840 left" and no exhaustion date, and the screen
 * says which of those situations it is in. It must still read as a working
 * screen: a page showing 0 with nothing else would look broken, which is why
 * the explanation is a sentence rather than an absence.
 *
 * ── AND IT IS NOT ALWAYS A MONTH ──
 * The design says "Conversations this month". The period comes from the
 * subscription, and on this tenant it runs a YEAR — 2026-09-08 to 2027-09-08.
 * So the screen names the period it actually has instead of asserting a month.
 */
export async function Runway({ allowance }: { readonly allowance: Allowance | null }) {
  const t = await getTranslations('billing');
  const locale = await getLocale();

  if (!allowance) {
    return (
      <p className={styles.unavailable} data-testid="runway-unavailable">
        {t('runway.unavailable')}
      </p>
    );
  }

  const number = new Intl.NumberFormat(locale);
  const day = new Intl.DateTimeFormat(locale, { dateStyle: 'long' });
  const periodEnd = day.format(new Date(allowance.periodEnd));

  // No allowance: the plan does not meter conversations at all.
  if (allowance.limit === null) {
    return (
      <div className={styles.runway} data-testid="runway" data-metered="no">
        <p className={styles.runwayCount} data-testid="runway-count">
          {t('runway.usedOnly', { used: number.format(allowance.used) })}
        </p>
        {/*
          The sentence that keeps this from reading as a broken screen. It says
          what IS true — this plan has no conversation allowance, and the
          period runs to a stated date — rather than leaving a zero to be
          interpreted.
        */}
        <p className={styles.runwayNote} data-testid="runway-unmetered">
          {t('runway.noAllowance', { until: periodEnd })}
        </p>
      </div>
    );
  }

  const left = Math.max(allowance.limit - allowance.used, 0);
  const proportion = allowance.limit > 0 ? Math.min(allowance.used / allowance.limit, 1) : 0;

  return (
    <div className={styles.runway} data-testid="runway" data-metered="yes">
      <p className={styles.runwayCount} data-testid="runway-count">
        <strong>{number.format(allowance.used)}</strong>
        {t('runway.of', { limit: number.format(allowance.limit) })}
      </p>

      {/*
        `aria-hidden`: the bar restates the numbers above it, and a progress
        element announced after them would read the same fact twice.
      */}
      <div className={styles.meter} aria-hidden="true">
        <div className={styles.meterFill} style={{ inlineSize: `${proportion * 100}%` }} />
      </div>

      <p className={styles.runwayNote} data-testid="runway-note">
        {allowance.projectedExhaustionAt
          ? t('runway.leftUntil', {
              left: number.format(left),
              until: day.format(new Date(allowance.projectedExhaustionAt)),
            })
          : /*
             * A limit but no projection: too little history to put a date on,
             * or a pace that does not reach the limit before the period ends.
             * Saying how many are left is true; inventing a date is not.
             */
            t('runway.left', { left: number.format(left) })}
      </p>
    </div>
  );
}
