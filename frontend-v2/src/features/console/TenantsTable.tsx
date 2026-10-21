import { useTranslations } from 'next-intl';

import type { ProvisioningStatus, TenantRow } from '@/api/contracts/console';
import { Button } from '@/design-system/primitives/button/Button';
import { Input } from '@/design-system/primitives/input/Input';
import { UserText } from '@/design-system/primitives/text/UserText';
import { Link } from '@/i18n/navigation';

import { PlanAccessBadge, TenantStatusBadge } from './badges';
import { tenantBillingState } from './billing-state';
import styles from './Console.module.css';

/**
 * Search, as legacy has it: name or slug, the route's own `contains` match
 * (system.ts:107). A GET form - the search is in the address, so a filtered
 * list is a link an operator can send.
 */
export function TenantSearch({ search }: { readonly search: string }) {
  const t = useTranslations('console.tenants.search');
  return (
    <form role="search" method="get" className={styles.search}>
      <Input
        label={t('label')}
        labelHidden
        name="q"
        type="search"
        defaultValue={search}
        placeholder={t('placeholder')}
      />
      <Button type="submit" variant="secondary" size="sm">
        {t('submit')}
      </Button>
    </form>
  );
}

/** A count the route did not send is a cell with nothing to say, never a 0. */
const cell = (value: number | null) => (value === null ? '-' : value);

/**
 * The tenants (legacy `system/tenants/page.tsx`): who, how many people and
 * conversations, the plan they hold, and the state they are in - with the
 * billing state a PENDING_PAYMENT tenant's own request decides. The name
 * opens the tenant's own page, where its actions are.
 */
export function TenantsTable({
  tenants,
  total,
  provisioning,
  search,
}: {
  readonly tenants: readonly TenantRow[];
  readonly total: number;
  readonly provisioning: Readonly<Record<string, ProvisioningStatus>>;
  readonly search: string;
}) {
  const t = useTranslations('console.tenants');

  if (tenants.length === 0) {
    return (
      <p className={styles.quiet} data-testid="tenants-empty">
        {search ? t('noMatch', { search }) : t('empty')}
      </p>
    );
  }

  return (
    <>
      <div className={styles.table} role="table" aria-label={t('title')}>
        <div className={styles.head} role="row">
          <span className={styles.colName} role="columnheader">
            {t('columns.organization')}
          </span>
          <span className={styles.colCount} role="columnheader">
            {t('columns.users')}
          </span>
          <span className={styles.colCount} role="columnheader">
            {t('columns.conversations')}
          </span>
          <span className={styles.colCount} role="columnheader">
            {t('columns.channels')}
          </span>
          <span className={styles.colBadge} role="columnheader">
            {t('columns.plan')}
          </span>
          <span className={styles.colBadge} role="columnheader">
            {t('columns.status')}
          </span>
        </div>
        {tenants.map((tenant) => {
          const billing = tenantBillingState(
            tenant.status,
            Object.hasOwn(provisioning, tenant.id) ? provisioning[tenant.id] : undefined,
          );
          return (
            <div
              key={tenant.id}
              className={styles.row}
              role="row"
              data-testid={`tenant-${tenant.id}`}
            >
              <span className={styles.colName} role="cell">
                <Link
                  href={`/system/tenants/${tenant.id}`}
                  className={`${styles.colName} ${styles.rowLink}`}
                >
                  <UserText className={styles.name}>{tenant.name}</UserText>
                  <span className={styles.slug} dir="ltr">
                    {tenant.slug}
                  </span>
                </Link>
              </span>
              <span className={styles.colCount} role="cell">
                {cell(tenant._count.users)}
              </span>
              <span className={styles.colCount} role="cell">
                {cell(tenant._count.conversations)}
              </span>
              <span className={styles.colCount} role="cell">
                {cell(tenant._count.channelAccounts)}
              </span>
              <span className={styles.colBadge} role="cell" data-testid="tenant-plan">
                <PlanAccessBadge access={tenant.planAccess} />
              </span>
              <span className={styles.colBadge} role="cell" data-testid="tenant-status">
                <TenantStatusBadge
                  status={tenant.status}
                  isActive={tenant.isActive}
                  billing={billing}
                />
              </span>
            </div>
          );
        })}
      </div>
      {total > tenants.length ? (
        <p className={styles.quiet} data-testid="tenants-shown">
          {t('shown', { shown: tenants.length, total })}
        </p>
      ) : null}
    </>
  );
}
