import { getTranslations } from 'next-intl/server';

import { Invoices } from '@/features/billing/BillingSections';
import { loadBilling } from '@/features/billing/load-billing';
import { pageMetadata } from '@/shell/page-metadata';
import { SettingsSection } from '@/shell/SettingsSection';

/**
 * Settings · Usage & billing · Invoices — every charge, behind the Billing
 * card's "All" on 17. Not drawn in 02; 17b's shape, "← Usage & billing"
 * above the title.
 */
export default async function Page() {
  const t = await getTranslations('billing.overview.invoicesPage');
  const nav = await getTranslations('navigation');
  const { invoices } = await loadBilling();

  return (
    <SettingsSection
      title={t('title')}
      description={t('description')}
      back={{ href: '/settings/billing', label: nav('settings.billing') }}
    >
      <Invoices invoices={invoices} />
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('settings.billing');
