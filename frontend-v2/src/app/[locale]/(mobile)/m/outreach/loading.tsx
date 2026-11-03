import { useTranslations } from 'next-intl';

import { MobileListSkeleton } from '@/features/mobile/MobileSkeletons';
import ui from '@/features/mobile/mobile-ui.module.css';
import { MobileBar } from '@/shell/mobile/MobileBar';

/** Outreach while it loads: the title for real, the four chips, a section, the campaigns. */
export default function Loading() {
  const t = useTranslations('mobile');
  return (
    <div className={ui.screen} data-testid="mobile-outreach-loading">
      <MobileBar title={t('outreach.title')} />
      <MobileListSkeleton label={t('loading.outreach')} chips={4} section rows={6} />
    </div>
  );
}
