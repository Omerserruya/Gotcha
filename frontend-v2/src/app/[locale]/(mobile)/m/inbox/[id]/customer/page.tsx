import { getTranslations } from 'next-intl/server';

import styles from '@/features/mobile/inbox/mobile-inbox.module.css';
import { loadCustomerInfo } from '@/features/mobile/inbox/load-customer-info';
import { MobileCustomerInfo } from '@/features/mobile/inbox/MobileCustomerInfo';
import ui from '@/features/mobile/mobile-ui.module.css';
import { MobileBar } from '@/shell/mobile/MobileBar';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * "מידע על הלקוח" from a conversation's ⋮ menu: a full screen over the
 * thread (no tabs, `inMobileOverlay`), whose way back is the thread.
 *
 * ★ READ ONLY, AND NO NEW ROUTE. The Copilot wall's own reads
 *   (`loadWallPerson`) with the notes and the CRM's beside them - see
 *   `load-customer-info.ts`. Writing a note, an order's actions and merging
 *   stay on the website.
 */
export default async function Page({ params }: { readonly params: Promise<{ readonly id: string }> }) {
  const { id } = await params;
  const t = await getTranslations('mobile');
  const read = await loadCustomerInfo(id);
  const back = {
    // A conversation is not a tab; the bar's type names the tabs, and this is under one.
    href: `/m/inbox/${encodeURIComponent(id)}` as '/m/inbox',
    label: t('customerInfo.back'),
  } as const;

  return (
    <div className={ui.screen} data-testid="mobile-customer-info-screen">
      <MobileBar back={back} title={t('customerInfo.title')} />
      <div className={ui.scroll}>
        {read.ok ? (
          <MobileCustomerInfo info={read.info} />
        ) : (
          <p className={styles.note} data-testid="mobile-customer-info-missing">
            {read.missing === 'unavailable' ? t('inbox.notAvailable') : t('customerInfo.failedAll')}
          </p>
        )}
      </div>
    </div>
  );
}

export const generateMetadata = pageMetadata('primary.inbox');
