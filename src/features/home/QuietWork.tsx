import { getTranslations } from 'next-intl/server';

import type { QuietDay } from '@/api/contracts/analytics';
import type { IntelligenceReview } from '@/api/contracts/intelligence-reviews';
import { Text } from '@/design-system/primitives/text/Text';
import { Link } from '@/i18n/navigation';

import { ConflictRow } from './ConflictRow';
import styles from './Home.module.css';
import { quietDayCopy } from './quiet-day-item';

/**
 * "Worth an hour, while it is quiet" — the quiet day's replacement for the queue.
 *
 * The list is merged and ranked by the server across four sources, so this
 * renders an order rather than deciding one.
 *
 * Two lists, not one. Three sources remove future work; dormant customers
 * create conversations, which is the point of them — ranking an opportunity by
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
  const work = items.filter((item) => item.effect === 'removes_work');
  const opportunities = items.filter((item) => item.effect === 'creates_opportunity');
  const rankerMissedConflicts = quietDay?.sources.knowledge_conflict === false;
  const isEmpty = items.length === 0 && conflicts.length === 0;

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
        {work.map((item) => (
          <QuietRow key={item.id} item={item} t={t} />
        ))}

        {conflicts.map((conflict) => (
          <ConflictRow key={conflict.id} conflict={conflict} />
        ))}

        {opportunities.map((item) => (
          <QuietRow key={item.id} item={item} t={t} />
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

function QuietRow({ item, t }: { item: QuietDay['data'][number]; t: Translate }) {
  const { key, values, href } = quietDayCopy(item);

  return (
    <div className={styles.workRow}>
      <div className={styles.workRowText}>
        <p className={styles.workRowTitle}>{t(`item.${key}.title`, values)}</p>
        <p className={styles.workRowBody}>{t(`item.${key}.body`, values)}</p>
      </div>
      <div className={styles.workRowActions}>
        <Link href={href} className={styles.actionSecondary}>
          {t(`item.${key}.action`)}
        </Link>
      </div>
    </div>
  );
}
