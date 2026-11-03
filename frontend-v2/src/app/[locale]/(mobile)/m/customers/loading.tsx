import { useTranslations } from 'next-intl';

import { MobileListSkeleton } from '@/features/mobile/MobileSkeletons';
import ui from '@/features/mobile/mobile-ui.module.css';
import { MobileBar } from '@/shell/mobile/MobileBar';

/** The customers while they load: the title for real, the search, the two chips, the people. */
export default function Loading() {
  const t = useTranslations('mobile');
  return (
    <div className={ui.screen} data-testid="mobile-customers-loading">
      <MobileBar title={t('customers.title')} />
      <MobileListSkeleton label={t('loading.customers')} search chips={2} rows={8} />
    </div>
  );
}
