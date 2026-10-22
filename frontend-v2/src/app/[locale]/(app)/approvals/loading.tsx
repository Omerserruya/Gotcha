import { useTranslations } from 'next-intl';

import { SkeletonCards } from '@/design-system/primitives/skeleton/Skeleton';
import { PageContainer } from '@/shell/PageContainer';

/** 05 the moment a navigation starts: its title and line, the decisions as placeholder cards. */
export default function Loading() {
  const t = useTranslations('approvals');
  const common = useTranslations('common');
  return (
    <PageContainer layout="screen" title={t('title')} description={t('description')}>
      <div data-testid="approvals-loading">
        <SkeletonCards label={common('loading')} count={3} columns={1} height={150} />
      </div>
    </PageContainer>
  );
}
