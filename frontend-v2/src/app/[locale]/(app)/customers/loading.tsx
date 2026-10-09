import { useTranslations } from 'next-intl';

import { SkeletonCards, SkeletonRows } from '@/design-system/primitives/skeleton/Skeleton';
import styles from '@/features/customers/Customers.module.css';
import { PageContainer } from '@/shell/PageContainer';

import { CustomersActions } from '@/features/customers/CustomersActions';

/**
 * 04 the moment a navigation starts: its title, line, search and Add - the
 * page's own - and its two columns as placeholders: the people, and the
 * side's cards.
 */
export default function Loading() {
  const t = useTranslations('customers');
  const common = useTranslations('common');
  return (
    <PageContainer
      layout="screen"
      fill
      title={t('title')}
      description={t('subline')}
      actions={<CustomersActions query="" />}
    >
      <div className={styles.columns} data-testid="customers-loading">
        <SkeletonRows label={common('loading')} rows={9} height={64} />
        <aside className={styles.side}>
          <SkeletonCards label={common('loading')} count={3} columns={1} height={110} />
        </aside>
      </div>
    </PageContainer>
  );
}
