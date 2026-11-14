import { useTranslations } from 'next-intl';

import { MobileThreadSkeleton } from '@/features/mobile/MobileSkeletons';
import ui from '@/features/mobile/mobile-ui.module.css';
import { MobileBarStill } from '@/shell/mobile/MobileBarStill';

/**
 * A conversation while it loads: the bar with its way back for real (who it
 * is with is read with the page), the bubbles on the thread's ground, the
 * composer's pill.
 */
export default function Loading() {
  const t = useTranslations('mobile');
  return (
    <div className={ui.screen} data-testid="mobile-thread-loading">
      <MobileBarStill back={{ href: '/m/inbox', label: t('inbox.back') }} edge />
      <MobileThreadSkeleton label={t('loading.thread')} />
    </div>
  );
}
