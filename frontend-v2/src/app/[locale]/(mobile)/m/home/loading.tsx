import { useTranslations } from 'next-intl';

import { Logo } from '@/design-system/brand/Logo';
import styles from '@/features/mobile/home/mobile-home.module.css';
import { MobileHomeSkeleton } from '@/features/mobile/MobileSkeletons';
import ui from '@/features/mobile/mobile-ui.module.css';
import { MobileAccountStill } from '@/shell/mobile/MobileBarStill';

/**
 * Home while it loads: its own bar, then the greeting, the day's card and the blocks.
 *
 * ⚠ The bar is `MobileHomeBar`'s markup, written here: importing it brings
 *   MobileHome's whole graph, client components included, and a loading file
 *   renders none (see `MobileBarStill`, `src/loading-no-client.test.ts`).
 */
export default function Loading() {
  const t = useTranslations('mobile.loading');
  return (
    <div className={ui.screen} data-testid="mobile-home-loading">
      <header className={styles.bar}>
        <span className={styles.brand}>
          <Logo size={30} />
          <span className={styles.wordmark}>GOTCHA</span>
        </span>
        <span className={styles.fill} />
        <MobileAccountStill />
      </header>
      <MobileHomeSkeleton label={t('home')} />
    </div>
  );
}
