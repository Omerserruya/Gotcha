import { useTranslations } from 'next-intl';

import { MobileHomeBar } from '@/features/mobile/home/MobileHome';
import { MobileHomeSkeleton } from '@/features/mobile/MobileSkeletons';
import ui from '@/features/mobile/mobile-ui.module.css';
import { MobileAccountMenu } from '@/shell/mobile/MobileAccountMenu';

/** Home while it loads: its own bar for real, then the greeting, the day's card and the blocks. */
export default function Loading() {
  const t = useTranslations('mobile.loading');
  return (
    <div className={ui.screen} data-testid="mobile-home-loading">
      <MobileHomeBar account={<MobileAccountMenu />} />
      <MobileHomeSkeleton label={t('home')} />
    </div>
  );
}
