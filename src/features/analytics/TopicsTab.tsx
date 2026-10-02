import { getFormatter, getTranslations } from 'next-intl/server';

import { humanizeTag } from '@/api/contracts/approvals';
import type { AskedAbout } from '@/api/contracts/analytics';
import { Link } from '@/i18n/navigation';

import type { TopicsData } from './load-analytics';
import styles from './Analytics.module.css';

/**
 * Screen 06e — what people are asking about. Measured.
 *
 * The dark card ("What changed") and a side card (824 + 300); then the topic
 * table (794) beside "by day" and "How people sound" (330).
 *
 * ── WHAT EACH PART IS MADE OF ──
 *   topics       `/top-questions` grouped by intent, this week and the week
 *                before — so "Change" is real, and a topic with none the week
 *                before is "new". Rows the route made from raw message
 *                bodies (no intents in range) are customers' words, not
 *                topics, and are not listed as topics.
 *   what changed the biggest rise among topics asked at least 5 times the
 *                week before — a rise from 1 to 3 is not news
 *   the side     the question GOTCHA most often could not answer
 *                (`/unanswered-questions`) — "Answer it once" goes to
 *                Knowledge, where it is answered
 *   "—"          GOTCHA alone and how it ends per topic, a topic by day, and
 *                how people sound: nothing counts them
 */

/** Below this many the week before, a percentage change is noise, not news. */
export const MIN_BASE = 5;

export interface TopicRow {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  /** Percent change on the week before; `'new'` with none then; `null` when unknown. */
  readonly change: number | 'new' | null;
}

/** An intent label in words: "order_status" → "Order status"; a phrase stays itself. */
export function topicWords(label: string): string {
  return /^[a-z0-9_.-]+$/.test(label) ? humanizeTag(label) : label;
}

export function topicRows(
  week: readonly AskedAbout[],
  before: readonly AskedAbout[] | null,
): readonly TopicRow[] {
  const previous = new Map(
    (before ?? []).filter((row) => row.intent).map((row) => [row.intent!, row.count]),
  );
  return week
    .filter((row) => row.intent && row.count > 0)
    .map((row) => {
      const was = before === null ? undefined : (previous.get(row.intent!) ?? 0);
      return {
        key: row.intent!,
        label: topicWords(row.question ?? row.intent!),
        count: row.count,
        change:
          was === undefined
            ? null
            : was === 0
              ? ('new' as const)
              : Math.round(((row.count - was) / was) * 100),
      };
    });
}

/** The biggest rise worth saying: on a base of at least `MIN_BASE`, and up. */
export function biggestRise(
  week: readonly AskedAbout[],
  before: readonly AskedAbout[] | null,
): TopicRow | null {
  if (!before) return null;
  const base = new Map(before.filter((row) => row.intent).map((row) => [row.intent!, row.count]));
  const rising = topicRows(week, before).filter(
    (row): row is TopicRow & { change: number } =>
      typeof row.change === 'number' && row.change > 0 && (base.get(row.key) ?? 0) >= MIN_BASE,
  );
  return rising.sort((a, b) => b.change - a.change)[0] ?? null;
}

export async function TopicsHero({ data }: { readonly data: TopicsData }) {
  const t = await getTranslations('analytics');
  const rise = data.week ? biggestRise(data.week, data.before) : null;
  return (
    <section className={styles.gHero} data-testid="topics-hero">
      <p className={styles.gHeroEyebrow}>{t('topics.hero.eyebrow')}</p>
      <p className={styles.gHeroTitle}>
        {data.week === null
          ? '—'
          : rise
            ? t.rich('topics.hero.rise', {
                topic: rise.label,
                pct: rise.change as number,
                figure: (chunks) => <span className={styles.gHeroAmber}>{chunks}</span>,
              })
            : t('topics.hero.steady')}
      </p>
      <div className={styles.gActions}>
        <span className={styles.gLight} aria-disabled="true">
          {t('topics.hero.update')}
        </span>
        <span className={styles.gDarkOutline} aria-disabled="true">
          {t('topics.hero.conversations')}
        </span>
      </div>
    </section>
  );
}

/** 02's side card, on what is recorded: the question GOTCHA most often could not answer. */
export async function UnansweredCard({ data }: { readonly data: TopicsData }) {
  const t = await getTranslations('analytics');
  const format = await getFormatter();
  const top = data.unanswered?.data[0] ?? null;
  return (
    <section className={styles.gStopped} data-testid="topics-unanswered">
      <h2 className={styles.gCardTitle}>{t('topics.unanswered.title')}</h2>
      <p className={styles.gCardBody}>
        {data.unanswered === null
          ? '—'
          : top
            ? t('topics.unanswered.body', {
                question: top.question,
                count: top.askCount,
                n: format.number(top.askCount),
              })
            : t('topics.unanswered.none')}
      </p>
      <div className={styles.gCardActions}>
        {top ? (
          <Link
            href={{ pathname: '/studio/knowledge' }}
            className={styles.gCardPrimary}
            data-testid="topics-answer"
          >
            {t('topics.unanswered.answer')}
          </Link>
        ) : null}
        {/* Topics are a regrouping of a raw column: a rename has nowhere to persist. */}
        <span className={styles.gCardSecondary} aria-disabled="true">
          {t('topics.unanswered.rename')}
        </span>
      </div>
    </section>
  );
}

export async function TopicTable({ data }: { readonly data: TopicsData }) {
  const t = await getTranslations('analytics');
  const format = await getFormatter();
  const rows = data.week ? topicRows(data.week, data.before) : [];
  const ungrouped = data.week !== null && rows.length === 0 && data.week.some((row) => !row.intent);
  return (
    <section className={styles.tTable} data-testid="topics-table">
      <div className={styles.eHead} aria-hidden="true">
        <span>{t('topics.table.topic')}</span>
        <span>{t('topics.table.asked')}</span>
        <span>{t('topics.table.change')}</span>
        <span>{t('topics.table.alone')}</span>
        <span>{t('topics.table.ends')}</span>
      </div>
      <div className={styles.tRows}>
        {data.week === null ? (
          <p className={styles.gNone} data-testid="topics-unavailable">
            {t('topics.table.unavailable')}
          </p>
        ) : rows.length === 0 ? (
          <p className={styles.gNone} data-testid="topics-none">
            {ungrouped ? t('topics.table.ungrouped') : t('topics.table.none')}
          </p>
        ) : (
          <ul className={styles.tList}>
            {rows.map((row) => (
              <li key={row.key} className={styles.eRow} data-testid={`topic-${row.key}`}>
                <span className={styles.eTopic}>{row.label}</span>
                <span className={styles.eCount}>{format.number(row.count)}</span>
                <span
                  className={styles.eChange}
                  data-tone={
                    row.change === 'new'
                      ? 'new'
                      : typeof row.change === 'number' && row.change >= 20
                        ? 'up'
                        : undefined
                  }
                >
                  {row.change === null
                    ? '—'
                    : row.change === 'new'
                      ? t('topics.table.new')
                      : t('topics.table.pct', { pct: row.change })}
                </span>
                {/* Nothing counts GOTCHA-alone or the ending per topic. */}
                <span className={styles.eMuted}>—</span>
                <span className={styles.eMuted}>—</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className={styles.tFoot}>{t('topics.table.foot')}</p>
    </section>
  );
}

/** "By day" for the top topic: the axis, 3px baselines — nothing counts a topic per day. */
export async function TopicByDay({
  data,
  days,
}: {
  readonly data: TopicsData;
  readonly days: readonly Date[];
}) {
  const t = await getTranslations('analytics');
  const format = await getFormatter();
  const top = data.week ? topicRows(data.week, data.before)[0] : undefined;
  return (
    <section className={styles.eSide} data-testid="topics-by-day">
      <h2 className={styles.gCardTitle}>
        {top ? t('topics.byDay.title', { topic: top.label }) : t('topics.byDay.titleNone')}
      </h2>
      <ol className={styles.eBars}>
        {days.map((day) => (
          <li key={day.toISOString()} className={styles.gBar}>
            <span className={styles.gBarTrack} aria-hidden="true" />
            <span className={styles.gBarLabel}>{format.dateTime(day, { weekday: 'narrow' })}</span>
          </li>
        ))}
      </ol>
      <p className={styles.gCardFoot}>{t('topics.byDay.none')}</p>
    </section>
  );
}

/** 02's "How people sound": the three rows, "—", and why. */
export async function HowTheySound() {
  const t = await getTranslations('analytics');
  const tones = ['fine', 'impatient', 'angry'] as const;
  return (
    <section className={styles.eSideTall} data-testid="topics-sound">
      <h2 className={styles.gCardTitle}>{t('topics.sound.title')}</h2>
      <ul className={styles.gDidList}>
        {tones.map((tone) => (
          <li key={tone} className={styles.gDidRow}>
            <span className={styles.gDidTop}>
              <span className={styles.gDidName}>{t(`topics.sound.${tone}`)}</span>
              <span className={styles.gDidCount}>—</span>
            </span>
            <span className={styles.gDidTrack} aria-hidden="true" />
          </li>
        ))}
      </ul>
      <p className={styles.gCardFoot}>{t('topics.sound.none')}</p>
    </section>
  );
}
