import { getFormatter, getTranslations } from 'next-intl/server';

import type { AnalyticsOverview, Insight, TimeSaved } from '@/api/contracts/analytics';
import { readableValues } from '@/api/contracts/capabilities';
import { channelName } from '@/api/contracts/inbox';
import { kindKey, rankInsights } from '@/features/home/WorthKnowing';

import styles from './Analytics.module.css';

/**
 * 06's top row — "What changed", dark, beside "Also worth a look".
 *
 * ★ The findings are the platform's own `insights`, ranked and worded exactly
 *   as Home's "Worth knowing" words them — one set of sentences for one set
 *   of findings. The strongest is the statement; the next three are the list.
 *
 * Not drawn: 02's "Send proactive update" and "See the conversations". An
 * insight carries a kind and values, not an action or the conversations
 * behind it.
 */
export async function WhatChanged({ insights }: { readonly insights: readonly Insight[] | null }) {
  const t = await getTranslations('analytics');
  const words = await getTranslations('home.insight');
  const channelNames = await getTranslations('channels');
  const ranked = insights ? rankInsights(insights) : [];
  const sentence = (insight: Insight) =>
    words.rich(kindKey(insight.kind), {
      ...readableValues(insight.values, (key, value) =>
        key === 'channel' ? channelName(value, channelNames) : null,
      ),
      b: (chunks) => <b>{chunks}</b>,
    });

  return (
    <div className={styles.changedRow}>
      <section className={styles.changed} data-testid="what-changed">
        <p className={styles.changedEyebrow}>{t('changed.eyebrow')}</p>
        <p className={styles.changedStatement}>
          {insights === null
            ? t('changed.unavailable')
            : ranked[0]
              ? sentence(ranked[0])
              : t('changed.none')}
        </p>
      </section>
      {ranked.length > 1 ? (
        <section className={styles.also} data-testid="also-worth">
          <h2 className={styles.cardTitle}>{t('changed.also')}</h2>
          <ul className={styles.alsoList}>
            {ranked.slice(1, 4).map((insight) => (
              <li key={insight.id} className={styles.alsoItem}>
                {sentence(insight)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/**
 * 06's strip of five — the week's figures, with the change against the week
 * before ONLY where the platform computes one.
 *
 * ⚠ `overview` returns a delta for the conversation count and nothing else.
 *   02 draws one on every figure ("+4", "−18s", "flat"); a delta we would have
 *   to compute from a second read of a differently-defined period is not
 *   drawn, and "flat" is never written for a delta nobody measured.
 */
export async function KpiStrip({
  overview,
  timeSaved,
}: {
  readonly overview: AnalyticsOverview | null;
  readonly timeSaved: TimeSaved | null;
}) {
  const t = await getTranslations('analytics');
  const format = await getFormatter();
  if (overview === null) {
    return (
      <p className={styles.note} data-testid="kpi-unavailable">
        {t('kpi.unavailable')}
      </p>
    );
  }
  const duration = (ms: number | null | undefined) => {
    if (ms === null || ms === undefined) return t('kpi.unknown');
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return t('kpi.seconds', { n: seconds });
    const minutes = Math.round(seconds / 60);
    return minutes < 60
      ? t('kpi.minutes', { n: minutes })
      : t('kpi.hours', { n: Math.round(minutes / 60) });
  };
  const delta = overview.deltas?.totalConversationsPct;
  const cells = [
    {
      key: 'conversations',
      value: format.number(overview.totalConversations),
      delta: delta === null || delta === undefined ? null : delta,
    },
    { key: 'handledByGotcha', value: `${overview.aiHandledPct}%`, delta: null },
    { key: 'resolved', value: `${overview.resolutionRate}%`, delta: null },
    { key: 'avgReply', value: duration(overview.avgResponseTimeMs), delta: null },
    {
      key: 'timeSaved',
      value: timeSaved === null ? t('kpi.unknown') : duration(timeSaved.secondsSaved * 1000),
      delta: null,
    },
  ] as const;
  return (
    <dl className={styles.kpis} data-testid="kpi-strip">
      {cells.map((cell) => (
        <div key={cell.key} className={styles.kpi} data-testid={`kpi-${cell.key}`}>
          <dt>{t(`kpi.${cell.key}`)}</dt>
          <dd>
            <span className={styles.kpiValue}>{cell.value}</span>
            {cell.delta === null ? null : (
              <span className={styles.kpiDelta} data-direction={cell.delta < 0 ? 'down' : 'up'}>
                {t('kpi.delta', {
                  value: `${cell.delta > 0 ? '+' : cell.delta < 0 ? '−' : ''}${Math.abs(cell.delta)}`,
                })}
              </span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
