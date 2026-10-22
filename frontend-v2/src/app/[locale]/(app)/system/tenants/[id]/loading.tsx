import { useTranslations } from 'next-intl';

import { SkeletonRows } from '@/design-system/primitives/skeleton/Skeleton';
import { PageContainer } from '@/shell/PageContainer';

/** A tenant before its first read, the console's sidebar still on screen. */
export default function Loading() {
  const t = useTranslations('common');
  return (
    <PageContainer layout="screen">
      <SkeletonRows label={t('loading')} rows={8} testid="route-skeleton" />
    </PageContainer>
  );
}
