'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';

import type { Coupon, TenantCoupon } from '@/api/contracts/console';
import { UserText } from '@/design-system/primitives/text/UserText';

import { ConfirmedAction } from './ConfirmedAction';
import styles from './Console.module.css';
import { assignTenantCoupon, revokeTenantCoupon } from './coupon-actions';
import { useRefusal } from './TenantBilling';

/**
 * One tenant's coupons (legacy `TenantCoupons.tsx`): what is discounting its
 * charges right now and until when, every assignment it has had, and giving
 * or stopping one. A coupon discounts a price; the plan and its contracted
 * price never change.
 *
 * A read that failed says so. Legacy hid the whole section then, which reads
 * exactly like "pays full price".
 */
export function TenantCoupons({
  tenantId,
  coupons,
  assignable,
}: {
  readonly tenantId: string;
  readonly coupons: readonly TenantCoupon[] | undefined;
  readonly assignable: readonly Coupon[] | undefined;
}) {
  const t = useTranslations('console.tenantCoupons');
  const format = useFormatter();
  const refusal = useRefusal();
  const [couponId, setCouponId] = useState('');
  const [months, setMonths] = useState('');
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium' });
  const chosen = assignable?.find((coupon) => coupon.id === couponId) ?? null;
  const monthsValue = months.trim() === '' ? null : Number(months);
  const monthsValid =
    monthsValue === null || (Number.isInteger(monthsValue) && (monthsValue as number) >= 1);

  if (coupons === undefined) {
    return (
      <section className={styles.card} aria-labelledby="tenant-coupons">
        <h2 id="tenant-coupons" className={styles.cardTitle}>
          {t('title')}
        </h2>
        <p className={styles.refused} role="alert" data-testid="tenant-coupons-unread">
          {t('unread')}
        </p>
      </section>
    );
  }

  const live = coupons.filter((coupon) => coupon.live);
  const windowMonths = chosen ? (monthsValue ?? chosen.defaultDurationMonths) : null;

  return (
    <section className={styles.card} aria-labelledby="tenant-coupons" data-testid="tenant-coupons">
      <h2 id="tenant-coupons" className={styles.cardTitle}>
        {t('title')}
      </h2>
      <p className={styles.quiet}>{t('what')}</p>

      <p className={styles.confirmSentence} data-testid="tenant-coupons-now">
        {live.length === 0
          ? t('fullPrice')
          : live[0]!.endsAt
            ? t('liveUntil', {
                codes: live.map((c) => c.code).join(', '),
                until: date(live[0]!.endsAt),
              })
            : t('liveOpen', { codes: live.map((c) => c.code).join(', ') })}
      </p>

      {coupons.length > 0 ? (
        <ul className={styles.list} role="list">
          {coupons.map((coupon) => (
            <li key={coupon.id} className={styles.listRow} data-testid={`assignment-${coupon.id}`}>
              <span className={styles.code} dir="ltr">
                {coupon.code}
              </span>
              <UserText>{coupon.label}</UserText>
              <span className={styles.quiet}>
                {coupon.endsAt
                  ? t('window', { from: date(coupon.startsAt), until: date(coupon.endsAt) })
                  : t('windowOpen', { from: date(coupon.startsAt) })}
              </span>
              <span className={styles.quiet} data-testid="assignment-state">
                {coupon.live ? t('state.live') : t(`state.${knownStatus(coupon.status)}`)}
              </span>
              {coupon.status === 'ACTIVE' ? (
                <ConfirmedAction
                  label={t('revoke.label')}
                  sentences={[t('revoke.what', { code: coupon.code })]}
                  yes={t('revoke.yes')}
                  run={() => revokeTenantCoupon(coupon.id)}
                  done={() => t('revoke.done', { code: coupon.code })}
                  refused={refusal}
                  testid={`revoke-${coupon.id}`}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {assignable === undefined ? (
        <p className={styles.refused} role="alert" data-testid="assignable-unread">
          {t('assignableUnread')}
        </p>
      ) : assignable.length === 0 ? (
        <p className={styles.quiet} data-testid="assignable-none">
          {t('assignableNone')}
        </p>
      ) : (
        <div className={styles.assign}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('give.coupon')}</span>
            <select
              className={styles.select}
              value={couponId}
              onChange={(event) => setCouponId(event.target.value)}
              data-testid="give-coupon-select"
            >
              <option value="">{t('give.choose')}</option>
              {assignable.map((coupon) => (
                <option key={coupon.id} value={coupon.id}>
                  {`${coupon.code} · ${coupon.label}`}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('give.months')}</span>
            <input
              className={styles.select}
              inputMode="numeric"
              value={months}
              placeholder={t('give.monthsDefault')}
              onChange={(event) => setMonths(event.target.value)}
              aria-invalid={monthsValid ? undefined : true}
              data-testid="give-coupon-months"
            />
          </label>
          <ConfirmedAction
            label={t('give.label')}
            disabled={!chosen || !monthsValid}
            sentences={
              chosen
                ? [
                    windowMonths
                      ? t('give.what', { code: chosen.code, months: windowMonths })
                      : t('give.whatOpen', { code: chosen.code }),
                    t('give.unchanged'),
                  ]
                : []
            }
            yes={t('give.yes')}
            run={() => assignTenantCoupon(tenantId, couponId, monthsValue)}
            done={() => t('give.done')}
            refused={refusal}
            testid="give-coupon"
          />
        </div>
      )}
    </section>
  );
}

const STATUSES = ['ACTIVE', 'EXPIRED', 'REVOKED'] as const;
const knownStatus = (status: string) =>
  (STATUSES as readonly string[]).includes(status) ? status : 'other';
