import { getTranslations } from 'next-intl/server';

import { billingWritesEnabled } from '@/api/client/billing-writes';
import { CouponsScreen } from '@/features/console/CouponsScreen';
import { loadCoupons } from '@/features/console/load-coupons';
import { pageMetadata } from '@/shell/page-metadata';
import { requireConsole } from '@/shell/require-console';
import { SettingsSection } from '@/shell/SettingsSection';

import styles from '@/features/console/Console.module.css';

/** Console · Coupons - legacy `/system/coupons`. */
export default async function Page() {
  await requireConsole();
  const [t, coupons] = await Promise.all([getTranslations('console.coupons'), loadCoupons()]);
  return (
    <SettingsSection title={t('title')} description={t('description')}>
      {billingWritesEnabled() ? null : (
        <p className={styles.notice} data-testid="billing-held">
          {t('held')}
        </p>
      )}
      <CouponsScreen coupons={coupons} />
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('sections.coupons', 'console');
