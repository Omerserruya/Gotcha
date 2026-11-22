import { getTranslations } from 'next-intl/server';

import { loadShopifyPrivateApps } from '@/features/console/load-shopify-private-apps';
import { ShopifyPrivateApps } from '@/features/console/ShopifyPrivateApps';
import { pageMetadata } from '@/shell/page-metadata';
import { requireConsole } from '@/shell/require-console';
import { SettingsSection } from '@/shell/SettingsSection';

/** Shopify private apps (Supervisor, 2026-11-22). System admins only, as every console page. */
export default async function Page() {
  if ((await requireConsole()) !== 'open') return null;
  const [t, read] = await Promise.all([
    getTranslations('console.shopifyApps'),
    loadShopifyPrivateApps(),
  ]);
  return (
    <SettingsSection title={t('pageTitle')} description={t('description')}>
      <ShopifyPrivateApps read={read} />
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('sections.shopifyApps', 'console');
