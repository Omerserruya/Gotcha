import { useTranslations } from 'next-intl';

import { MobileProfileSkeleton } from '@/features/mobile/MobileSkeletons';
import ui from '@/features/mobile/mobile-ui.module.css';
import { MobileBar } from '@/shell/mobile/MobileBar';

/** One customer while it loads: the way back for real, the face, the tiles, the history card. */
export default function Loading() {
  const t = useTranslations('mobile');
  return (
    <div className={ui.screen} data-testid="mobile-customer-loading">
      <MobileBar back={{ href: '/m/customers', label: t('customers.back') }} />
      <MobileProfileSkeleton label={t('loading.customer')} />
    </div>
  );
}
