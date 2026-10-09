import { useTranslations } from 'next-intl';

import {
  Skeleton,
  SkeletonRegion,
  SkeletonRows,
  SkeletonStats,
} from '@/design-system/primitives/skeleton/Skeleton';
import styles from '@/features/home/Home.module.css';

/**
 * Home the moment a navigation starts. Everything on it is read - the
 * greeting is the viewer's name and the hour, the line is the day's
 * figures - so it is Home's own layout with placeholders in each place:
 * the status strip, the greeting, the command box, the figures, the list.
 */
export default function Loading() {
  const common = useTranslations('common');
  const loading = common('loading');
  return (
    // Home's own padding (each block on the page sets 34 / 40); busy, and said so.
    <div
      className={styles.loading}
      data-testid="home-loading"
      aria-busy="true"
      aria-label={loading}
    >
      <SkeletonRegion label={loading}>
        <Skeleton height="36px" />
        <header className={styles.greeting}>
          <Skeleton shape="text" width="160px" />
          <Skeleton width="min(420px, 70%)" height="44px" />
          <Skeleton shape="text" width="min(520px, 85%)" />
        </header>
        <Skeleton height="96px" />
      </SkeletonRegion>
      <SkeletonStats label={loading} count={4} />
      <SkeletonRows label={loading} rows={5} />
    </div>
  );
}
