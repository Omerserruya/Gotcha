import { useTranslations } from 'next-intl';

import { MobileDetailSkeleton } from '@/features/mobile/MobileSkeletons';
import ui from '@/features/mobile/mobile-ui.module.css';
import { MobileBarStill } from '@/shell/mobile/MobileBarStill';

/** One campaign while it loads: the bar for real, then the campaign's sheet. */
export default function Loading() {
  const t = useTranslations('mobile');
  return (
    <div className={ui.screen} data-testid="mobile-campaign-loading">
      <MobileBarStill
        back={{ href: '/m/outreach', label: t('outreach.back') }}
        title={t('outreach.title')}
      />
      <MobileDetailSkeleton label={t('loading.campaign')} />
    </div>
  );
}
