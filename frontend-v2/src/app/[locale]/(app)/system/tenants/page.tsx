import { getTranslations } from 'next-intl/server';

import { loadTenants } from '@/features/console/load-tenants';
import { TenantSearch, TenantsTable } from '@/features/console/TenantsTable';
import { pageMetadata } from '@/shell/page-metadata';
import { requireConsole } from '@/shell/require-console';
import { SettingsSection } from '@/shell/SettingsSection';

import styles from '@/features/console/Console.module.css';

/** Console · Tenants - legacy `/system/tenants`. The search is the address's `?q=`. */
export default async function Page({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly q?: string | string[] }>;
}) {
  await requireConsole();
  const { q } = await searchParams;
  const search = (Array.isArray(q) ? q[0] : q)?.trim() ?? '';
  const [t, list] = await Promise.all([getTranslations('console.tenants'), loadTenants(search)]);

  return (
    <SettingsSection title={t('title')} description={t('description')}>
      <TenantSearch search={search} />
      {list.ok ? (
        <TenantsTable
          tenants={list.tenants}
          total={list.total}
          provisioning={list.provisioning}
          search={search}
        />
      ) : (
        <p className={styles.quiet} role="alert" data-testid="tenants-unread">
          {t('unread')}
        </p>
      )}
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('sections.tenants', 'console');
