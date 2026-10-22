import { getFormatter, getTranslations } from 'next-intl/server';

import type { AnalyticsOverview, Insight, TimeSaved } from '@/api/contracts/analytics';
import { readableValues } from '@/api/contracts/capabilities';
import { channelName } from '@/api/contracts/inbox';
import { kindKey, rankInsights } from '@/features/home/WorthKnowing';

import { estimateBasis } from './figures';
import styles from './Analytics.module.css';

/**
 * 06's top row - "What changed", dark, beside "Also worth a look".
 *
 * ★ The findings are the platform's own `insights`, ranked and worded exactly
 *   as Home's "Worth knowing" words them - one set of sentences for one set
 *   of findings. The strongest is the statement; the next three are the list.
 *
 * Not drawn: 02's "Send proactive update" and "See the conversations". An
 * insight carries a kind and values, not an action or the conversations
 * behind it.
 */
/*
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ WHICH INSIGHTS ARE CHANGES - TODAY, NONE
 * ════════════════════════════════════════════════════════════════════════════
 * 02's dark card is an anomaly: "Shipping questions are up 43%", a change
 * against the period before. Every kind the platform emits is a LEVEL over
 * its own window - `channel.highest_volume` is "68 conversations came through
 * WhatsApp in the last 30 days", a standing fact. Put under "What changed" on
 * a week with zero conversations, it told a different story from the strip
 * below it (and its 68 were an import, counted by creation date).
 *
 * So the card shows only kinds listed here, and none is. A kind joins when
 * the platform emits a delta against a prior period.
 */
const CHANGE_KINDS: ReadonlySet<string> = new Set<string>([]);

export async function WhatChanged({ insights }: { readonly insights: readonly Insight[] | null }) {
  const t = await getTranslations('analytics');
  const words = await getTranslations('home.insight');
  const channelNames = await getTranslations('channels');
  const ranked = insights ? rankInsights(insights) : [];
  const changes = ranked.filter((insight) => CHANGE_KINDS.has(insight.kind));
  const standing = ranked.filter((insight) => !CHANGE_KINDS.has(insight.kind));
  const sentence = (insight: Insight) =>
    words.rich(kindKey(insight.kind), {
      ...readableValues(insight.values, (key, value) =>
        key === 'channel' ? channelName(value, channelNames) : null,
      ),
      b: (chunks) => <b>{chunks}</b>,
    });

  return (
    <div className={styles.changedRow}>
      {/*
        ★★ Always drawn, in 02's shape (824 beside the 300) - Omer's rule:
        missing data is shown in its shape. It holds only a CHANGE; with none,
        a neutral line, no figure and no arrow.
      */}
      <section
        className={styles.changed}
        data-testid="what-changed"
        data-empty={changes[0] ? undefined : ''}
      >
        <p className={styles.changedEyebrow}>{t('changed.eyebrow')}</p>
        <p className={styles.changedStatement}>
          {insights === null
            ? t('changed.unavailable')
            : changes[0]
              ? sentence(changes[0])
              : t('changed.nothing')}
        </p>
      </section>
      {/*
        Standing facts, each in its own window - every sentence names its
        period ("in the last 30 days"), which is why they may sit on a page
        about the last seven.
      */}
      <section className={styles.also} data-testid="also-worth">
        <h2 className={styles.cardTitle}>{t('changed.also')}</h2>
        {insights === null ? (
          <p className={styles.alsoNone} data-testid="insights-unavailable">
            -
          </p>
        ) : standing.length > 0 ? (
          <ul className={styles.alsoList}>
            {standing.slice(0, 3).map((insight) => (
              <li key={insight.id} className={styles.alsoItem}>
                {sentence(insight)}
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.alsoNone}>{t('changed.none')}</p>
        )}
      </section>
    </div>
  );
}

/**
 * 06's strip of five - the week's figures, with the change against the week
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
  const share = (pct: number) => (overview.totalConversations > 0 ? `${pct}%` : t('kpi.unknown'));
  const delta = overview.deltas?.totalConversationsPct;
  const cells = [
    {
      key: 'conversations',
      value: format.number(overview.totalConversations),
      delta: delta === null || delta === undefined ? null : delta,
    },
    /*
     * ⚠ A SHARE OF NOTHING IS NOT 0%. With no conversations in the week there
     *   is no denominator; "-", as the reply time already says.
     */
    { key: 'handledByGotcha', value: share(overview.aiHandledPct), delta: null },
    { key: 'resolved', value: share(overview.resolutionRate), delta: null },
    { key: 'avgReply', value: duration(overview.avgResponseTimeMs), delta: null },
    {
      key: 'timeSaved',
      value:
        timeSaved === null || timeSaved.secondsSaved <= 0
          ? t('kpi.unknown')
          : duration(timeSaved.secondsSaved * 1000),
      delta: null,
    },
  ] as const;
  // Time saved, when it is the platform's average and not this workspace's own.
  const estimate = estimateBasis(timeSaved);
  return (
    <dl className={styles.kpis} data-testid="kpi-strip">
      {cells.map((cell) => (
        <div key={cell.key} className={styles.kpi} data-testid={`kpi-${cell.key}`}>
          <dt>{t(`kpi.${cell.key}`)}</dt>
          <dd>
            <span
              className={styles.kpiValue}
              title={cell.key === 'timeSaved' && estimate ? t('kpi.estimate', estimate) : undefined}
            >
              {cell.value}
            </span>
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
