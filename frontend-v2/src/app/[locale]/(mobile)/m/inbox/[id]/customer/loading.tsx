'use client';

import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Skeleton, SkeletonRegion } from '@/design-system/primitives/skeleton/Skeleton';
import styles from '@/features/mobile/inbox/mobile-inbox.module.css';
import ui from '@/features/mobile/mobile-ui.module.css';
import { MobileBar } from '@/shell/mobile/MobileBar';

/** The sections, in the screen's order, each at the height its card usually is. */
const SECTIONS = [96, 150, 120, 80, 80] as const;

/**
 * The customer screen while it loads: the bar for real, with its way back to
 * the thread (a `loading.tsx` is given no params, so the id is read from the
 * address here), then a face and five sections in their shape.
 */
export default function Loading() {
  const t = useTranslations('mobile');
  const params = useParams<{ id?: string }>();
  const id = typeof params?.id === 'string' ? params.id : null;
  return (
    <div className={ui.screen} data-testid="mobile-customer-info-loading">
      <MobileBar
        back={{
          href: (id === null ? '/m/inbox' : `/m/inbox/${encodeURIComponent(id)}`) as '/m/inbox',
          label: t('customerInfo.back'),
        }}
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
