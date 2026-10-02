import { getFormatter, getTranslations } from 'next-intl/server';

import { namedTopics, type AskedAbout as Topic } from '@/api/contracts/analytics';

import styles from './Analytics.module.css';
import { UserText } from '@/design-system/primitives/text/UserText';

/**
 * 06's "What people ask about".
 *
 * This is what became of screen 06e. Topics are a `groupBy` over
 * `detectedIntent` recomputed per request — there is no `Topic` model — so
 * rename and merge have nowhere to persist to, and a screen built around
 * controls that cannot save would have been one real column beside six empty
 * ones.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──
 * No rename, no merge, no new-topic flag, no period-over-period change, no
 * AI-alone rate, no how-it-ends, no sentiment, no "automatable".
 *
 * The change column and the new-topic flag are the two worth naming, because
 * they are *derivable* — two queries would produce them — and they are still
 * out. The label is an unconstrained model-written string, so
 * **an unmerged variant would read as a brand-new topic**: a spelling
 * difference rendered as the most attention-grabbing thing on the panel.
 * Derivable is not the same as true.
 */
export async function AskedAbout({
  topics,
}: {
  /** `null` when the read failed. Never an empty list. */
  readonly topics: readonly Topic[] | null;
}) {
  const t = await getTranslations('analytics');
  const format = await getFormatter();

  if (topics === null) {
    return (
      <section className={styles.panel} data-testid="asked-unavailable">
        <h2 className={styles.panelHeading}>{t('asked.heading')}</h2>
        <p className={styles.note}>{t('asked.unavailable')}</p>
      </section>
    );
  }

  const rows = namedTopics(topics);

  return (
    <section className={styles.panel} data-testid="asked-about">
      <h2 className={styles.panelHeading}>{t('asked.heading')}</h2>

      {/*
        ★★ THE CAPTION IS LOAD-BEARING, NOT DECORATION.
        `detectedIntent` is model-written and unconstrained, so "where is my
        order" and "order status" arrive as two rows. Saying GOTCHA did the
        grouping means a reader who sees two rows that look like one question
        knows we know — rather than concluding the counts are broken, which is
        what an uncaptioned list would teach them.
      */}
      <p className={styles.note} data-testid="asked-caption" title={t('asked.grouped')}>
        {t('askedShort.grouped')}
      </p>

      {rows.length === 0 ? (
        <p className={styles.note} data-testid="asked-none">
          {t('asked.none')}
        </p>
      ) : (
        <ol className={styles.topicList}>
          {rows.map((topic) => (
            <li
              key={topic.question}
              className={styles.topic}
              data-testid={`topic-${topic.question}`}
            >
              {/* Model-written, in whatever language the customer asked in. */}
              <span className={styles.topicName}>
                <UserText>{topic.question}</UserText>
              </span>
              <span className={styles.topicCount}>
                {t('asked.asked', { count: format.number(topic.count) })}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
