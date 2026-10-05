import { getFormatter, getTranslations } from 'next-intl/server';

import type { DailySeries, DayRow } from '@/api/contracts/analytics';

import styles from './Analytics.module.css';

/**
 * 06 and 06b's day chart: seven columns, the dark part beneath the light one,
 * each day's height against the busiest. Unread (`null`), the axis stays —
 * the last seven days, empty — and a sentence says so; no figure is invented.
 */
async function StackedDays({
  testId,
  title,
  legend,
  daily,
  dark,
  light,
  fallbackDays,
  unread,
  why,
}: {
  readonly testId: string;
  readonly title: string;
  readonly legend: string;
  readonly daily: DailySeries | null;
  readonly dark: (row: DayRow) => number;
  readonly light: (row: DayRow) => number;
  /** The axis when nothing was read: local days, as the rest of the screen draws them. */
  readonly fallbackDays: readonly Date[];
  readonly unread: string;
  readonly why: string;
}) {
  const t = await getTranslations('analytics.daily');
  const format = await getFormatter();
  const rows = daily?.series ?? null;
  const busiest = Math.max(1, ...(rows ?? []).map((r) => dark(r) + light(r)));
  const share = (n: number) => `${Math.round((n / busiest) * 10_000) / 100}%`;
  // The series' days are UTC dates: named in UTC, so "2026-10-05" is that day's name.
  const columns = rows
    ? rows.map((row) => ({
        key: row.date,
        at: new Date(`${row.date}T00:00:00Z`),
        zone: 'UTC' as const,
        row,
      }))
    : fallbackDays.map((day) => ({
        key: day.toISOString(),
        at: day,
        zone: undefined,
        row: null,
      }));
  return (
    <section className={styles.dChart} data-testid={testId} title={why}>
      <header className={styles.gChartHead}>
        <h2 className={styles.gCardTitle}>{title}</h2>
        <span className={styles.gCardMeta}>{legend}</span>
      </header>
      <ol className={styles.dBars}>
        {columns.map(({ key, at, zone, row }, i) => (
          <li
            key={key}
            className={styles.dBar}
            data-testid={`${testId}-day-${i}`}
            aria-label={
              row
                ? t('dayLabel', {
                    day: format.dateTime(at, { weekday: 'long', timeZone: zone }),
                    dark: dark(row),
                    light: light(row),
                  })
                : undefined
            }
          >
            <span className={styles.dStack} aria-hidden="true">
              {row && dark(row) + light(row) > 0 ? (
                <>
                  <span className={styles.dLight} style={{ blockSize: share(light(row)) }} />
                  <span className={styles.dDark} style={{ blockSize: share(dark(row)) }} />
                </>
              ) : (
                <span className={styles.gBarTrack} />
              )}
            </span>
            <span className={styles.gBarLabel}>
              {format.dateTime(at, { weekday: 'short', timeZone: zone })}
            </span>
          </li>
        ))}
      </ol>
      {rows === null ? <p className={styles.gCardFoot}>{unread}</p> : null}
    </section>
  );
}

/** 06 Overview: answered each day — GOTCHA alone (dark), a person replied (light). */
export async function ConversationsADay({
  daily,
  fallbackDays,
}: {
  readonly daily: DailySeries | null;
  readonly fallbackDays: readonly Date[];
}) {
  const t = await getTranslations('analytics.daily');
  return StackedDays({
    testId: 'conversations-a-day',
    title: t('title'),
    legend: t('legend'),
    why: t('why'),
    unread: t('unread'),
    daily,
    dark: (r) => r.gotcha,
    light: (r) => r.team,
    fallbackDays,
  });
}

/** 06b: started each day — GOTCHA alone (dark), passed over to a person (light). */
export async function AloneChart({
  daily,
  fallbackDays,
}: {
  readonly daily: DailySeries | null;
  readonly fallbackDays: readonly Date[];
}) {
  const t = await getTranslations('analytics');
  return StackedDays({
    testId: 'gotcha-alone',
    title: t('gotcha.alone.title'),
    legend: t('gotcha.alone.legend'),
    why: t('gotcha.alone.why'),
    unread: t('daily.unread'),
    daily,
    dark: (r) => r.alone,
    light: (r) => r.passedOver,
    fallbackDays,
  });
}
