import { useTranslations } from 'next-intl';

import { MobileDetailSkeleton } from '@/features/mobile/MobileSkeletons';
import ui from '@/features/mobile/mobile-ui.module.css';
import { MobileBar } from '@/shell/mobile/MobileBar';

/** One request while it loads: the way back for real, then the request's card and its two buttons. */
export default function Loading() {
  const t = useTranslations('mobile');
  return (
    <div className={ui.screen} data-testid="mobile-approval-loading">
      <MobileBar back={{ href: '/m/approvals', label: t('approvals.back') }} />
      <MobileDetailSkeleton label={t('loading.approval')} />
    </div>
  );
}
