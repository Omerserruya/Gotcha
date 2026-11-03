import { useTranslations } from 'next-intl';

import { MobileCardsSkeleton } from '@/features/mobile/MobileSkeletons';
import ui from '@/features/mobile/mobile-ui.module.css';
import { MobileBar } from '@/shell/mobile/MobileBar';

/** The approvals while they load: the title for real, the lead line, the two chips, request cards. */
export default function Loading() {
  const t = useTranslations('mobile');
  return (
    <div className={ui.screen} data-testid="mobile-approvals-loading">
      <MobileBar title={t('approvals.title')} />
      <MobileCardsSkeleton label={t('loading.approvals')} />
    </div>
  );
}
