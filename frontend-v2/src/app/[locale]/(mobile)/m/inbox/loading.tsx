import { useTranslations } from 'next-intl';

import { MobileListSkeleton } from '@/features/mobile/MobileSkeletons';
import ui from '@/features/mobile/mobile-ui.module.css';
import { MobileBarStill } from '@/shell/mobile/MobileBarStill';

/** The inbox while it loads: the wordmark for real, then the search, the six view chips, the rows. */
export default function Loading() {
  const t = useTranslations('mobile.loading');
  return (
    <div className={ui.screen} data-testid="mobile-inbox-loading">
      <MobileBarStill brand />
      <MobileListSkeleton label={t('inbox')} search chips={6} rows={8} />
    </div>
  );
}
