import { getTranslations } from 'next-intl/server';

import { billingWritesEnabled } from '@/api/client/billing-writes';
import { UserText } from '@/design-system/primitives/text/UserText';
import { loadTenant } from '@/features/console/load-tenant';
import { TenantBilling } from '@/features/console/TenantBilling';
import { TenantControls } from '@/features/console/TenantControls';
import { TenantCoupons } from '@/features/console/TenantCoupons';
import { TenantFacts } from '@/features/console/TenantFacts';
import { pageMetadata } from '@/shell/page-metadata';
import { requireConsole } from '@/shell/require-console';
import { SettingsSection } from '@/shell/SettingsSection';

import styles from '@/features/console/Console.module.css';

/**
 * Console · one tenant - legacy `/system/tenants/[id]`, the parts in scope:
 * its facts, its billing (provisioning, repair, resend, a plan for a tenant
 * with none) and its coupons. Users, features, entitlements, bot settings,
 * the AI prompt viewer and deleting the tenant are not ported.
 */
export default async function Page({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  await requireConsole();
  const { id } = await params;
  const [t, nav, data] = await Promise.all([
    getTranslations('console.detail'),
    getTranslations('console.sections'),
    loadTenant(id),
  ]);
  const back = { href: '/system/tenants', label: nav('tenants') };

  if (!data.tenant.ok) {
    return (
      <SettingsSection title={t('unreadTitle')} back={back}>
        <p className={styles.refused} role="alert" data-testid="tenant-unread">
          {data.tenant.missing ? t('missing') : t('unread')}
        </p>
      </SettingsSection>
    );
  }

  const tenant = data.tenant.value;
  return (
    <SettingsSection title={<UserText>{tenant.name}</UserText>} back={back}>
      {billingWritesEnabled() ? null : (
        <p className={styles.notice} data-testid="billing-held">
          {t('billingHeld')}
        </p>
      )}
      <TenantFacts tenant={tenant} provisioning={data.provisioning} />
      <TenantBilling
        tenantId={tenant.id}
        status={tenant.status}
        access={tenant.planAccess}
        provisioning={data.provisioning}
        plans={data.plans}
      />
      <TenantCoupons tenantId={tenant.id} coupons={data.coupons} assignable={data.assignable} />
      <TenantControls
        tenantId={tenant.id}
        name={tenant.name}
        status={tenant.status}
        isActive={tenant.isActive}
      />
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('sections.tenants', 'console');
