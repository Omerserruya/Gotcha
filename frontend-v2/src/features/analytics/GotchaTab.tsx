import { getFormatter, getTranslations } from 'next-intl/server';

import { classifyDispatchError, humanizeTag } from '@/api/contracts/approvals';
import type { Integration } from '@/api/contracts/integrations';
import { Link } from '@/i18n/navigation';
import type { ToolUsage } from '@/api/contracts/capabilities';
import { UNANSWERED_PAGE } from '@/api/contracts/analytics';

import { estimateBasis, hadConversations, hoursSaved } from './figures';
import type { GotchaData } from './load-analytics';
import styles from './Analytics.module.css';

/**
 * Screen 06b - what GOTCHA did, and where it stopped. Measured.
 *
 * The dark card and "Where it stopped" (824 + 300), a five-figure strip, then
 * "Alone, or with a person" (794) and "What it actually did" (330).
 * `padding:24px 40px 30px`, `gap:16px`.
 *
 * ── WHAT EACH PART IS MADE OF ──
 *   the dark card      `aiHandledCount` - conversations whose FIRST reply was
 *                      GOTCHA's. Not "closed without anyone reading them":
 *                      nothing records that, and the sentence says what is.
 *                      Hours saved from /time-saved.
 *   where it stopped   needed your approval (/ai-performance); did not know
 *                      (/unanswered-questions - at most 50 rows, so "50+");
 *                      asked for a person: "-", no handover cause is stored
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

/**
 * ★ WHY THEY FAILED, WHEN ONE CONNECTION ACCOUNTS FOR THEM - 02's "Both
 * failures were the same payment method. Fix the automation." on real data.
 *
 * `/tool-usage` carries counts, not errors, so the reason comes from the
 * connections: a failing tool belongs to an integration by its prefix
 * (`shopify.…` → `shopify`), and that integration is failing with a
 * connection-class error (the same classes as 03b). Two facts, said as two
 * facts - "the failures were Shopify actions, and Shopify's connection is
 * down" - not more causation than the data holds.
 */
export function failuresByDownConnection(
  tools: readonly ToolUsage[],
  integrations: readonly Integration[],
): { readonly name: string; readonly count: number; readonly total: number } | null {
  const failedOf = (tool: ToolUsage) =>
    (tool.erroredCount ?? 0) + (tool.unclassifiedFailureCount ?? 0);
  const total = tools.reduce((sum, tool) => sum + failedOf(tool), 0);
  if (total === 0) return null;
  // Down: in ERROR, or its last error is the connection's (401, token, OAuth).
  const down = integrations.filter(
    (integration) =>
      integration.tenantConnection?.status === 'ERROR' ||
      classifyDispatchError(integration.tenantConnection?.lastError) === 'connection',
  );
  let best: { name: string; count: number } | null = null;
  for (const integration of down) {
    const prefix = `${integration.slug.toLowerCase()}.`;
    const count = tools
      .filter((tool) => tool.toolName.toLowerCase().startsWith(prefix))
      .reduce((sum, tool) => sum + failedOf(tool), 0);
    if (count > 0 && (!best || count > best.count)) best = { name: integration.name, count };
  }
  return best ? { ...best, total } : null;
}

/** "shopify.lookup_order" → "Lookup order". */
export function toolWords(name: string): string {
  return humanizeTag(name.split('.').pop() ?? name);
}

export async function GotchaHero({ data }: { readonly data: GotchaData }) {
  const t = await getTranslations('analytics');
  const format = await getFormatter();
  const hours = hoursSaved(data.timeSaved);
  // No conversations: nothing to credit GOTCHA with - said, not "0 … 0 hours".
  const quiet = data.overview !== null && !hadConversations(data.overview);
  return (
    <section className={styles.gHero} data-testid="gotcha-hero">
      <p className={styles.gHeroEyebrow}>{t('gotcha.hero.eyebrow')}</p>
      <p className={styles.gHeroTitle}>
        {quiet
          ? t('gotcha.hero.quiet')
          : data.overview
            ? t.rich('gotcha.hero.title', {
                count: data.overview.aiHandledCount,
                n: format.number(data.overview.aiHandledCount),
                figure: (chunks) => <span className={styles.gHeroFigure}>{chunks}</span>,
              })
            : '-'}
      </p>
      {hours !== null && !quiet ? (
        <p className={styles.gHeroLine}>
          {t('gotcha.hero.hours', { hours: format.number(hours) })}
        </p>
      ) : null}
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
    : null;
  /*
    `null` is a figure we do not have, and it gets its own sentence: a "-"
    dropped into "- asked for a person outright." does not read.
  */
  const rows: readonly {
    key: 'person' | 'unknown' | 'approval';
    count: string | null;
    tone: string;
  }[] = [
    // No handover cause is stored: "asked for a person" cannot be counted.
    { key: 'person', count: null, tone: 'amber' },
    { key: 'unknown', count: unknown, tone: 'red' },
    {
      key: 'approval',
      count: data.ai ? format.number(data.ai.approvals.requested) : null,
      tone: 'violet',
    },
  ];
  return (
    <section className={styles.gStopped} data-testid="gotcha-stopped">
      <h2 className={styles.gCardTitle}>{t('gotcha.stopped.title')}</h2>
      <ul className={styles.gStoppedList}>
        {rows.map((row) => (
          <li key={row.key} data-tone={row.tone} data-testid={`stopped-${row.key}`}>
            {row.count === null
              ? t(`gotcha.stopped.${row.key}None`)
              : t(`gotcha.stopped.${row.key}`, { count: row.count })}
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
  const hours = hoursSaved(data.timeSaved);
  const estimate = estimateBasis(data.timeSaved);
  const cells = [
    {
      key: 'alone',
      // No percentage of nothing: with no conversations, "-", never "0%".
      value: hadConversations(data.overview)
        ? `${format.number(data.overview!.aiHandledPct)}%`
        : '-',
    },
    { key: 'actions', value: actions === null ? '-' : format.number(actions) },
    { key: 'approval', value: data.ai ? format.number(data.ai.approvals.requested) : '-' },
    { key: 'failed', value: failed === null ? '-' : format.number(failed) },
    {
      key: 'saved',
      value: hours === null ? '-' : t('gotcha.strip.hours', { hours: format.number(hours) }),
    },
  ] as const;
  return (
    <dl className={styles.gStrip} data-testid="gotcha-strip">
      {cells.map((cell) => (
        <div key={cell.key} className={styles.gCell} data-testid={`gotcha-${cell.key}`}>
          <dt>{t(`gotcha.strip.${cell.key}`)}</dt>
          <dd title={cell.key === 'saved' && estimate ? t('kpi.estimate', estimate) : undefined}>
            {cell.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The last seven days, oldest first - the chart's axis. */
export function lastSevenDayDates(now: Date): readonly Date[] {
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - (6 - index));
    return day;
  });
}

export async function WhatItDid({
  tools,
  integrations = null,
}: {
  readonly tools: readonly ToolUsage[] | null;
  readonly integrations?: readonly Integration[] | null;
}) {
  const t = await getTranslations('analytics');
  const format = await getFormatter();
  const top = (tools ?? []).slice(0, 6);
  const max = Math.max(1, ...top.map((tool) => tool.executionCount));
  const refused = (tools ?? []).reduce((sum, tool) => sum + tool.refusedCount, 0);
  const failed = tools ? failedCount(tools) : null;
  const cause = tools && integrations ? failuresByDownConnection(tools, integrations) : null;
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
      {cause ? (
        <p className={styles.gDidFoot} data-testid="did-cause">
          {cause.count === cause.total
            ? t('gotcha.did.allOneCause', { count: format.number(cause.total), name: cause.name })
            : t('gotcha.did.someOneCause', {
                count: format.number(cause.count),
                total: format.number(cause.total),
                name: cause.name,
              })}{' '}
          <Link
            href={{ pathname: '/settings/systems' }}
            className={styles.gFix}
            data-testid="did-reconnect"
          >
            {t('gotcha.did.reconnect')}
          </Link>
        </p>
      ) : tools !== null && top.length > 0 ? (
        <p className={styles.gDidFoot} data-testid="did-foot">
          {failed === null
            ? t('gotcha.did.footNoFailed', { refused: format.number(refused) })
            : t('gotcha.did.foot', {
                failed: format.number(failed),
                refused: format.number(refused),
              })}
        </p>
      ) : null}
    </section>
  );
}
