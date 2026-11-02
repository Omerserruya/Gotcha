import { getTranslations } from 'next-intl/server';

import { loadCustomer } from '@/features/customers/load-customer';
import { MobileCustomerCard } from '@/features/mobile/customers/MobileCustomers';
import styles from '@/features/mobile/customers/mobile-customers.module.css';
import { OnWebsite } from '@/features/mobile/OnWebsite';
import { MobileBar } from '@/shell/mobile/MobileBar';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * One customer on the phone: the card, read only.
 *
 * ★ `loadCustomer`, the desktop's, so the person resolved through a merge is
 *   the person shown, and each of its reads fails on its own. Without the
 *   timeline there is no person to draw, and that is said - in the desktop's
 *   sentence - rather than an empty card.
 *
 * Notes, tags, orders, actions and merging are edited on the website.
 */
export default async function Page({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const { id } = await params;
  const t = await getTranslations('mobile');
  const tc = await getTranslations('customers');
  const detail = await loadCustomer(id);
  const back = { href: '/m/customers', label: t('customers.back') } as const;
  const website = (
    <OnWebsite path={`/customers/${encodeURIComponent(id)}`} label={t('customers.website')} />
  );

  if (detail.timeline === null) {
    return (
      <div className={styles.screen}>
        <MobileBar back={back} title={t('customers.title')} />
        <div className={styles.scroll}>
          <p className={styles.note} role="status" data-testid="mobile-customer-unavailable">
            {tc('detail.unavailable')}
          </p>
          {website}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.screen} data-testid="mobile-customer">
      <MobileBar back={back} title={t('customers.title')} />
      <div className={styles.scroll}>
        <MobileCustomerCard detail={detail} now={new Date()} />
        {website}
      </div>
    </div>
  );
}

export const generateMetadata = pageMetadata('primary.customers');
