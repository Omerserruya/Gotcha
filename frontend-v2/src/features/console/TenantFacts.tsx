import { useFormatter, useTranslations } from 'next-intl';

import type { ProvisioningStatus, TenantDetail } from '@/api/contracts/console';
import { UserText } from '@/design-system/primitives/text/UserText';

import { PlanAccessBadge, TenantStatusBadge } from './badges';
import { tenantBillingState } from './billing-state';
import styles from './Console.module.css';

/**
 * Who the tenant is: slug, since when, its status and plan (side by side -
 * "enabled" and "has a plan" are different facts), the route's counts and
 * its channels.
 */
export function TenantFacts({
  tenant,
  provisioning,
}: {
  readonly tenant: TenantDetail;
  readonly provisioning: ProvisioningStatus | undefined;
}) {
  const t = useTranslations('console.detail');
  const format = useFormatter();
  const counts = [
    ['users', tenant._count.users],
    ['conversations', tenant._count.conversations],
    ['messages', tenant._count.messages],
    ['channels', tenant._count.channelAccounts],
    ['teams', tenant._count.departments],
  ] as const;

  return (
    <section className={styles.card} aria-labelledby="tenant-facts" data-testid="tenant-facts">
      <h2 id="tenant-facts" className={styles.cardTitle}>
        {t('facts')}
      </h2>
      <dl className={styles.facts}>
        <dt>{t('slug')}</dt>
        <dd className={styles.code} dir="ltr">
          {tenant.slug}
        </dd>
        <dt>{t('created')}</dt>
        <dd>{format.dateTime(new Date(tenant.createdAt), { dateStyle: 'medium' })}</dd>
        <dt>{t('status')}</dt>
        <dd data-testid="detail-status">
          <TenantStatusBadge
            status={tenant.status}
            isActive={tenant.isActive}
            billing={tenantBillingState(tenant.status, provisioning)}
          />
        </dd>
        <dt>{t('plan')}</dt>
        <dd>
          <PlanAccessBadge access={tenant.planAccess} />
        </dd>
        {counts.flatMap(([key, value]) => [
          <dt key={`${key}-label`}>{t(`count.${key}`)}</dt>,
          <dd key={key} data-testid={`count-${key}`}>
            {value === null ? '-' : value}
          </dd>,
        ])}
      </dl>
      {tenant.channels.length > 0 ? (
        <ul className={styles.list} role="list" aria-label={t('channels')}>
          {tenant.channels.map((channel) => (
            <li key={channel.id} className={styles.listRow}>
              <span className={styles.code} dir="ltr">
                {channel.channel}
              </span>
              {channel.displayName ? <UserText>{channel.displayName}</UserText> : null}
              <span className={styles.quiet}>
                {channel.connectionStatus === 'CONNECTED' ? t('connected') : t('notConnected')}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
