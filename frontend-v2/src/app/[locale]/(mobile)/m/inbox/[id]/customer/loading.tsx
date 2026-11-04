import { useTranslations } from 'next-intl';

import { Skeleton, SkeletonRegion } from '@/design-system/primitives/skeleton/Skeleton';
import styles from '@/features/mobile/inbox/mobile-inbox.module.css';
import ui from '@/features/mobile/mobile-ui.module.css';
import { MobileBar } from '@/shell/mobile/MobileBar';

/** The sections, in the screen's order, each at the height its card usually is. */
const SECTIONS = [96, 150, 120, 80, 80] as const;

/**
 * The customer screen while it loads: the bar, then a face and five sections
 * in their shape.
 *
 * ⚠⚠ A SERVER COMPONENT, LIKE EVERY OTHER `loading.tsx` HERE. It was a client
 *    one (to read the id for its back link), and from inside the app the
 *    screen then never left its loading state: the page arrived and was not
 *    shown (Omer, 2026-11-04). A `loading.tsx` is given no params, so while
 *    it shows, back goes to the inbox, as the thread's own loading does.
 */
export default function Loading() {
  const t = useTranslations('mobile');
  return (
    <div className={ui.screen} data-testid="mobile-customer-info-loading">
      <MobileBar
        back={{ href: '/m/inbox', label: t('inbox.back') }}
        title={t('customerInfo.title')}
      />
      <div className={ui.scroll}>
        <SkeletonRegion label={t('customerInfo.loading')}>
          <div className={styles.info}>
            <div className={styles.infoHead}>
              <Skeleton shape="circle" width="50px" height="50px" />
              <span className={styles.infoWho}>
                <Skeleton shape="text" width="140px" height="17px" />
                <Skeleton shape="text" width="70px" height="12px" />
              </span>
            </div>
            {SECTIONS.map((height, index) => (
              <div key={index} className={styles.infoSection}>
                <div className={ui.section}>
                  <Skeleton shape="text" width={`${26 + (index % 3) * 8}%`} height="12px" />
                </div>
                <Skeleton width="100%" height={`${height}px`} />
              </div>
            ))}
          </div>
        </SkeletonRegion>
      </div>
    </div>
  );
}
