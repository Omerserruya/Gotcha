import { useTranslations } from 'next-intl';

import { MobileDetailSkeleton } from '@/features/mobile/MobileSkeletons';
import ui from '@/features/mobile/mobile-ui.module.css';
import { MobileBarStill } from '@/shell/mobile/MobileBarStill';

/** The ask screen while it opens: its bar for real, not Home's placeholders. */
export default function Loading() {
  const t = useTranslations('mobile');
  return (
    <div className={ui.screen} data-testid="mobile-ask-loading">
      <MobileBarStill
        back={{ href: '/m/home', label: t('home.askScreen.back') }}
        title={t('home.askScreen.title')}
      />
      <MobileDetailSkeleton label={t('loading.ask')} />
    </div>
  );
}
