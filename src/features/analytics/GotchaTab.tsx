import { getFormatter, getTranslations } from 'next-intl/server';

import { humanizeTag } from '@/api/contracts/approvals';
import type { ToolUsage } from '@/api/contracts/capabilities';
import { UNANSWERED_PAGE } from '@/api/contracts/analytics';

import type { GotchaData } from './load-analytics';
import styles from './Analytics.module.css';

/**
 * Screen 06b — what GOTCHA did, and where it stopped. Measured.
 *
 * The dark card and "Where it stopped" (824 + 300), a five-figure strip, then
 * "Alone, or with a person" (794) and "What it actually did" (330).
 * `padding:24px 40px 30px`, `gap:16px`.
 *
 * ── WHAT EACH PART IS MADE OF ──
 *   the dark card      `aiHandledCount` — conversations whose FIRST reply was
 *                      GOTCHA's. Not "closed without anyone reading them":
 *                      nothing records that, and the sentence says what is.
 *                      Hours saved from /time-saved.
 *   where it stopped   needed your approval (/ai-performance); did not know
 *                      (/unanswered-questions — at most 50 rows, so "50+");
 *                      asked for a person: "—", no handover cause is stored
 *   the strip          handled first by GOTCHA %, actions run, needed
 *                      approval, failed, time saved. No week-before figures
 *                      exist for most, so no deltas are invented.
 *   alone or a person  the seven days as the axis, the bars empty: nothing
 *                      splits a day's conversations by who answered
 *   what it did        /tool-usage, by tool; refusals (a rule working) apart
 *                      from failures (a call breaking)
 */

/** Failures across the tools: errored + unclassified. `null` when any tool's split is unknown. */
export function failedCount(tools: readonly ToolUsage[]): number | null {
  let total = 0;
  for (const tool of tools) {
    if (tool.erroredCount === undefined || tool.unclassifiedFailureCount === undefined) return null;
    total += tool.erroredCount + tool.unclassifiedFailureCount;
  }
  return total;
}

/** "shopify.lookup_order" → "Lookup order". */
export function toolWords(name: string): string {
  return humanizeTag(name.split('.').pop() ?? name);
}

export async function GotchaHero({ data }: { readonly data: GotchaData }) {
  const t = await getTranslations('analytics');
  const format = await getFormatter();
  const hours = data.timeSaved ? Math.round(data.timeSaved.secondsSaved / 3600) : null;
  return (
    <section className={styles.gHero} data-testid="gotcha-hero">
      <p className={styles.gHeroEyebrow}>{t('gotcha.hero.eyebrow')}</p>
      <p className={styles.gHeroTitle}>
        {data.overview
          ? t.rich('gotcha.hero.title', {
              count: data.overview.aiHandledCount,
              n: format.number(data.overview.aiHandledCount),
              figure: (chunks) => <span className={styles.gHeroFigure}>{chunks}</span>,
            })
          : '—'}
      </p>
      <p className={styles.gHeroLine}>
        {hours === null ? '—' : t('gotcha.hero.hours', { hours: format.number(hours) })}
      </p>
      <div className={styles.gActions}>
        <span className={styles.gLight} aria-disabled="true">
          {t('gotcha.hero.passedOver')}
        </span>
        <span className={styles.gDarkOutline} aria-disabled="true">
          {t('gotcha.hero.why')}
        </span>
      </div>
    </section>
  );
}

export async function WhereStopped({ data }: { readonly data: GotchaData }) {
  const t = await getTranslations('analytics');
  const format = await getFormatter();
  const unknown = data.unanswered
    ? data.unanswered.data.length >= UNANSWERED_PAGE
      ? `${format.number(UNANSWERED_PAGE)}+`
      : format.number(data.unanswered.data.length)
    : '—';
  const rows = [
    // No handover cause is stored: "asked for a person" cannot be counted.
    { key: 'person', count: '—', tone: 'amber' },
    { key: 'unknown', count: unknown, tone: 'red' },
    {
      key: 'approval',
      count: data.ai ? format.number(data.ai.approvals.requested) : '—',
      tone: 'violet',
    },
  ] as const;
  return (
    <section className={styles.gStopped} data-testid="gotcha-stopped">
      <h2 className={styles.gCardTitle}>{t('gotcha.stopped.title')}</h2>
      <ul className={styles.gStoppedList}>
        {rows.map((row) => (
          <li key={row.key} data-tone={row.tone} data-testid={`stopped-${row.key}`}>
            {t(`gotcha.stopped.${row.key}`, { count: row.count })}
          </li>
        ))}
      </ul>
    </section>
  );
}

export async function GotchaStrip({ data }: { readonly data: GotchaData }) {
  const t = await getTranslations('analytics');
  const format = await getFormatter();
  const actions = data.tools
    ? data.tools.reduce((sum, tool) => sum + tool.executionCount, 0)
    : null;
  const failed = data.tools ? failedCount(data.tools) : null;
  const hours = data.timeSaved ? Math.round(data.timeSaved.secondsSaved / 3600) : null;
  const cells = [
    { key: 'alone', value: data.overview ? `${format.number(data.overview.aiHandledPct)}%` : '—' },
    { key: 'actions', value: actions === null ? '—' : format.number(actions) },
    { key: 'approval', value: data.ai ? format.number(data.ai.approvals.requested) : '—' },
    { key: 'failed', value: failed === null ? '—' : format.number(failed) },
    {
      key: 'saved',
      value: hours === null ? '—' : t('gotcha.strip.hours', { hours: format.number(hours) }),
    },
  ] as const;
  return (
    <dl className={styles.gStrip} data-testid="gotcha-strip">
      {cells.map((cell) => (
        <div key={cell.key} className={styles.gCell} data-testid={`gotcha-${cell.key}`}>
          <dt>{t(`gotcha.strip.${cell.key}`)}</dt>
          <dd>{cell.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The seven days as the axis; the bars empty — nothing splits a day by who answered. */
export async function AloneChart({ days }: { readonly days: readonly Date[] }) {
  const t = await getTranslations('analytics');
  const format = await getFormatter();
  return (
    <section className={styles.gChart} data-testid="gotcha-alone">
      <header className={styles.gChartHead}>
        <h2 className={styles.gCardTitle}>{t('gotcha.alone.title')}</h2>
        <span className={styles.gCardMeta}>{t('gotcha.alone.legend')}</span>
      </header>
      <ol className={styles.gBars}>
        {days.map((day) => (
          <li key={day.toISOString()} className={styles.gBar}>
            <span className={styles.gBarTrack} aria-hidden="true" />
            <span className={styles.gBarLabel}>{format.dateTime(day, { weekday: 'short' })}</span>
          </li>
        ))}
      </ol>
      <p className={styles.gCardFoot}>{t('gotcha.alone.none')}</p>
    </section>
  );
}

/** The last seven days, oldest first — the chart's axis. */
export function lastSevenDayDates(now: Date): readonly Date[] {
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - (6 - index));
    return day;
  });
}

export async function WhatItDid({ tools }: { readonly tools: readonly ToolUsage[] | null }) {
  const t = await getTranslations('analytics');
  const format = await getFormatter();
  const top = (tools ?? []).slice(0, 6);
  const max = Math.max(1, ...top.map((tool) => tool.executionCount));
  const refused = (tools ?? []).reduce((sum, tool) => sum + tool.refusedCount, 0);
  const failed = tools ? failedCount(tools) : null;
  return (
    <section className={styles.gDid} data-testid="gotcha-did">
      <h2 className={styles.gCardTitle}>{t('gotcha.did.title')}</h2>
      {tools === null ? (
        <p className={styles.gNone}>{t('gotcha.did.unavailable')}</p>
      ) : top.length === 0 ? (
        <p className={styles.gNone}>{t('gotcha.did.none')}</p>
      ) : (
        <ul className={styles.gDidList}>
          {top.map((tool) => (
            <li key={tool.toolName} className={styles.gDidRow} data-testid={`did-${tool.toolName}`}>
              <span className={styles.gDidTop}>
                <span className={styles.gDidName} title={tool.toolName}>
                  {toolWords(tool.toolName)}
                </span>
                <span className={styles.gDidCount}>{format.number(tool.executionCount)}</span>
              </span>
              <span className={styles.gDidTrack} aria-hidden="true">
                <span
                  className={styles.gDidFill}
                  style={{ inlineSize: `${Math.round((tool.executionCount / max) * 100)}%` }}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
      {/* A refusal is a rule working; a failure is a call breaking. Said apart. */}
      {tools !== null && top.length > 0 ? (
        <p className={styles.gDidFoot} data-testid="did-foot">
          {t('gotcha.did.foot', {
            failed: failed === null ? '—' : format.number(failed),
            refused: format.number(refused),
          })}
        </p>
      ) : null}
    </section>
  );
}
