import { getTranslations } from 'next-intl/server';

import type { QuietDay } from '@/api/contracts/analytics';
import type { IntelligenceReview } from '@/api/contracts/intelligence-reviews';
import { Text } from '@/design-system/primitives/text/Text';
import { Link } from '@/i18n/navigation';

import { ConflictRow } from './ConflictRow';
import styles from './Home.module.css';
import { quietRows, type QuietRow } from './quiet-day-item';

/**
 * "Worth an hour, while it is quiet" - the quiet day's replacement for the queue.
 *
 * The list is merged and ranked by the server across four sources, so this
 * renders an order rather than deciding one.
 *
 * Two lists, not one. Three sources remove future work; dormant customers
 * create conversations, which is the point of them - ranking an opportunity by
 * how much work it removes would put the most valuable item last for being
 * valuable. The server keeps them apart and so does this.
 *
 * Conflicts are the exception: they live in another service and the ranker
 * does not see them yet, so they come from `/api/intelligence-reviews` and are
 * rendered after the ranked work with the card saying as much. They keep their
 * real approve/reject actions.
 */
export async function QuietWork({
  quietDay,
  conflicts,
}: {
  /** Null when the call failed. Empty `data` means nothing stands out. */
  quietDay: QuietDay | null;
  conflicts: readonly IntelligenceReview[];
}) {
  const t = await getTranslations('home.quietWork');

  const items = quietDay?.data ?? [];
  const rows = quietRows(items);
  const work = rows.filter((row) => row.effect === 'removes_work');
  const opportunities = rows.filter((row) => row.effect === 'creates_opportunity');
  const rankerMissedConflicts = quietDay?.sources.knowledge_conflict === false;
  const isEmpty = rows.length === 0 && conflicts.length === 0;
  /* 02: the first row's action is the dark one. */
  const firstKey = work[0]?.source ?? (conflicts.length > 0 ? null : opportunities[0]?.source);

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
        {work.map((row) => (
          <QuietRowView key={row.source} row={row} t={t} primary={row.source === firstKey} />
        ))}

        {conflicts.map((conflict) => (
          <ConflictRow key={conflict.id} conflict={conflict} />
        ))}

        {opportunities.map((row) => (
          <QuietRowView key={row.source} row={row} t={t} primary={row.source === firstKey} />
        ))}

        <p className={styles.workFooter}>
          {quietDay === null
            ? t('unavailable')
            : isEmpty
              ? t('empty')
              : rankerMissedConflicts && conflicts.length > 0
                ? `${t('footnote')} ${t('missingSource')}`
                : t('footnote')}
        </p>
      </div>
    </>
  );
}

type Translate = ReturnType<typeof getTranslations> extends Promise<infer T> ? T : never;

const TONE_CLASS = {
  gap: styles.workRowGap,
  conflict: styles.workRowConflict,
  opportunity: styles.workRowOpportunity,
} as const;

function QuietRowView({ row, t, primary }: { row: QuietRow; t: Translate; primary: boolean }) {
  return (
    <div
      className={[styles.workRow, row.tone ? TONE_CLASS[row.tone] : ''].join(' ').trim()}
      data-testid={`quiet-row-${row.source}`}
      data-tone={row.tone ?? 'none'}
    >
      <div className={styles.workRowText}>
        <p className={styles.workRowTitle}>{t(`item.${row.key}.title`, row.values)}</p>
        <p className={styles.workRowBody}>{t(`item.${row.key}.body`, row.values)}</p>
      </div>
      <div className={styles.workRowActions}>
        <Link href={row.href} className={primary ? styles.actionPrimary : styles.actionSecondary}>
          {t(`item.${row.key}.action`, row.values)}
        </Link>
      </div>
    </div>
  );
}
