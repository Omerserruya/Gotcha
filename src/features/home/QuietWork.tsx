import { getTranslations } from 'next-intl/server';

import type { IntelligenceReview } from '@/api/contracts/intelligence-reviews';
import { Text } from '@/design-system/primitives/text/Text';

import { ConflictRow } from './ConflictRow';
import styles from './Home.module.css';

/**
 * "Worth an hour, while it is quiet" — the quiet day's replacement for the queue.
 *
 * A single white card of rows, each with a coloured edge for urgency and one
 * action on the right. The design draws four; exactly one of them has a data
 * source.
 *
 *   ✓ two sources disagree      → /api/intelligence-reviews, with real actions
 *   ✗ questions it could not answer → top-questions cannot separate failure
 *                                     from frequency
 *   ✗ customers who went quiet      → no segment, and nothing joins one to a draft
 *   ✗ demand for unstocked products → nothing detects it
 *
 * The three without a source are absent rather than mocked, and the card says
 * so at its foot. Showing four rows where three are invented would make the
 * screen look finished and be a lie.
 */
export async function QuietWork({ conflicts }: { conflicts: readonly IntelligenceReview[] }) {
  const t = await getTranslations('home.quietWork');

  return (
    <>
      <div className={styles.sectionHeader}>
        <Text role="label" as="h2">
          {t('title')}
        </Text>
        <Text role="caption" tone="subtle" as="span">
          {t('subtitle')}
        </Text>
      </div>

      <div className={styles.workCard}>
        {conflicts.map((conflict) => (
          <ConflictRow key={conflict.id} conflict={conflict} />
        ))}

        <p className={styles.workFooter}>
          {conflicts.length > 0 ? t('remainingBlocked') : t('allBlocked')}
        </p>
      </div>
    </>
  );
}
