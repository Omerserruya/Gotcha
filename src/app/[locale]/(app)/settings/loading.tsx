import { useTranslations } from 'next-intl';

import { SkeletonRows } from '@/design-system/primitives/skeleton/Skeleton';
import { PageContainer } from '@/shell/PageContainer';

/**
 * A settings page before its first read: as `(app)/loading.tsx`, one level
 * in, so the settings navigation (this segment's layout) stays on screen.
 */
export default function Loading() {
  const t = useTranslations('common');
  return (
    // Rows in the card, where a page's content will land. Its own title and
    // buttons are the page's: they draw the moment the page answers.
    <PageContainer layout="screen">
      <SkeletonRows label={t('loading')} rows={8} testid="route-skeleton" />
    </PageContainer>
  );
}
