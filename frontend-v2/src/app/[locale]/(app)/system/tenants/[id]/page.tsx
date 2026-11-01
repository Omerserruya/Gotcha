import { getTranslations } from 'next-intl/server';

import { billingWritesEnabled } from '@/api/client/billing-writes';
import { UserText } from '@/design-system/primitives/text/UserText';
import { loadTenant } from '@/features/console/load-tenant';
import { loadCreateOptions } from '@/features/console/load-tenants';
import { TenantBilling } from '@/features/console/TenantBilling';
import { TenantControls } from '@/features/console/TenantControls';
import { TenantCoupons } from '@/features/console/TenantCoupons';
import { TenantFacts } from '@/features/console/TenantFacts';
import { TenantDelete } from '@/features/console/TenantDelete';
import { TenantMembers } from '@/features/console/TenantMembers';
import { TenantPlanEdit } from '@/features/console/TenantPlanEdit';
import { SupportEnter } from '@/features/support/SupportEnter';
import { pageMetadata } from '@/shell/page-metadata';
import { requireConsole } from '@/shell/require-console';
import { SettingsSection } from '@/shell/SettingsSection';

import styles from '@/features/console/Console.module.css';

/**
 * Console · one tenant - legacy `/system/tenants/[id]`, the parts in scope:
 * its facts, its billing (provisioning, repair, resend, a plan for a tenant
 * with none) and its coupons. Features, entitlements, bot settings and the
 * AI prompt viewer are not ported. Its owners and users are edited by hand
 * (Backend's manual-edit contract), as are its plan, end date, POC and
 * credits (never a charge), and the last card deletes it for good.
 */
export default async function Page({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly id: string }>;
  readonly searchParams: Promise<{ readonly support?: string | string[] }>;
}) {
  await requireConsole();
  const { id } = await params;
  const { support } = await searchParams;
  const [t, nav, data, options] = await Promise.all([
    getTranslations('console.detail'),
    getTranslations('console.sections'),
    loadTenant(id),
    loadCreateOptions(),
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
      {/* Support mode (Omer, 2026-11-01): work inside this workspace as its admin. */}
      <SupportEnter tenantId={tenant.id} ended={support === 'ended'} />
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
        planActive={tenant.planAccess.active}
      />
      <TenantPlanEdit tenantId={tenant.id} plans={options.plans} domains={options.domains} />
      <TenantMembers tenantId={tenant.id} members={tenant.users} />
      <TenantDelete tenantId={tenant.id} name={tenant.name} slug={tenant.slug} />
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('sections.tenants', 'console');
