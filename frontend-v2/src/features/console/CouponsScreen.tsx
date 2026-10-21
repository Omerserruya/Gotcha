'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';

import type { Coupon } from '@/api/contracts/console';
import { Button } from '@/design-system/primitives/button/Button';
import { Input } from '@/design-system/primitives/input/Input';
import { UserText } from '@/design-system/primitives/text/UserText';
import { useRouter } from '@/i18n/navigation';

import { ConfirmedAction } from './ConfirmedAction';
import styles from './Console.module.css';
import { createCoupon, setCouponActive } from './coupon-actions';
import { useRefusal } from './TenantBilling';

/** The price the worked example is computed on - legacy's, real and recognisable. */
export const EXAMPLE_PRICE = 499;

/**
 * Coupons (legacy `system/coupons/page.tsx`): issue one, see every one, and
 * switch one on or off. Giving a coupon to an organization is on that
 * organization's page.
 *
 * A coupon is a DISCOUNT ON A PRICE, never a different price: the plan and
 * its contracted price do not change, and when the window closes the charge
 * returns to what it always said.
 */
export function CouponsScreen({ coupons }: { readonly coupons: readonly Coupon[] | undefined }) {
  return (
    <>
      <CreateCoupon />
      <CouponList coupons={coupons} />
    </>
  );
}

function CouponList({ coupons }: { readonly coupons: readonly Coupon[] | undefined }) {
  const t = useTranslations('console.coupons');
  const refusal = useRefusal();

  if (coupons === undefined) {
    return (
      <p className={styles.refused} role="alert" data-testid="coupons-unread">
        {t('unread')}
      </p>
    );
  }
  if (coupons.length === 0) {
    return (
      <p className={styles.quiet} data-testid="coupons-empty">
        {t('empty')}
      </p>
    );
  }

  return (
    <section className={styles.card} aria-labelledby="coupons-issued">
      <h2 id="coupons-issued" className={styles.cardTitle}>
        {t('issued')}
      </h2>
      <ul className={styles.list} role="list">
        {coupons.map((coupon) => (
          <li key={coupon.id} className={styles.listRow} data-testid={`coupon-${coupon.id}`}>
            <span className={styles.code} dir="ltr">
              {coupon.code}
            </span>
            {coupon.nameEn ? <UserText>{coupon.nameEn}</UserText> : null}
            <UserText>{coupon.label}</UserText>
            <span className={styles.quiet}>
              {coupon.defaultDurationMonths
                ? t('window', { months: coupon.defaultDurationMonths })
                : t('windowOpen')}
            </span>
            <span className={styles.quiet} data-testid="coupon-given">
              {coupon.maxRedemptions === null
                ? t('given', { count: coupon.assignmentCount })
                : t('givenOfMax', { count: coupon.assignmentCount, max: coupon.maxRedemptions })}
            </span>
            <span className={styles.quiet} data-testid="coupon-state">
              {coupon.active ? t('active') : t('disabled')}
            </span>
            <ConfirmedAction
              label={coupon.active ? t('disable.label') : t('enable.label')}
              sentences={[
                coupon.active
                  ? t('disable.what', { code: coupon.code })
                  : t('enable.what', { code: coupon.code }),
              ]}
              yes={coupon.active ? t('disable.yes') : t('enable.yes')}
              run={() => setCouponActive(coupon.id, !coupon.active)}
              done={() =>
                coupon.active
                  ? t('disable.done', { code: coupon.code })
                  : t('enable.done', { code: coupon.code })
              }
              refused={refusal}
              testid={`coupon-active-${coupon.id}`}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

const wholeOrNull = (value: string) => (value.trim() === '' ? null : Number(value));
const isWhole = (value: number | null) => value === null || (Number.isInteger(value) && value >= 1);

/**
 * Issue a coupon. The worked example is the point (legacy's own words): "20%"
 * means nothing at a glance, "₪499 becomes ₪399.20, every month for 12
 * months" stops somebody typing 90 when they meant 9. It is an illustration
 * on a fixed price; the route decides what any real charge becomes.
 */
function CreateCoupon() {
  const t = useTranslations('console.coupons.create');
  const format = useFormatter();
  const refusal = useRefusal();
  const router = useRouter();
  const [code, setCode] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [nameHe, setNameHe] = useState('');
  const [discountType, setDiscountType] = useState<'PERCENT' | 'FIXED'>('PERCENT');
  const [percentOff, setPercentOff] = useState('20');
  const [amountOff, setAmountOff] = useState('50.00');
  const [currency, setCurrency] = useState('ILS');
  const [months, setMonths] = useState('12');
  const [maxRedemptions, setMaxRedemptions] = useState('');
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);

  const monthsValue = wholeOrNull(months);
  const maxValue = wholeOrNull(maxRedemptions);
  const ils = (value: number) =>
    format.number(value, { style: 'currency', currency: 'ILS', maximumFractionDigits: 2 });

  const example = (() => {
    if (discountType === 'PERCENT') {
      const pct = Number(percentOff);
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return null;
      const off = Math.round(EXAMPLE_PRICE * pct) / 100;
      return t('example', {
        price: ils(EXAMPLE_PRICE),
        after: ils(EXAMPLE_PRICE - off),
        off: ils(off),
      });
    }
    const amount = Number(amountOff);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    if (currency !== 'ILS') return t('exampleOtherCurrency', { currency });
    return t('example', {
      price: ils(EXAMPLE_PRICE),
      after: ils(Math.max(0, EXAMPLE_PRICE - amount)),
      off: ils(Math.min(amount, EXAMPLE_PRICE)),
    });
  })();

  const ready =
    code.trim() !== '' && nameEn.trim() !== '' && isWhole(monthsValue) && isWhole(maxValue);

  return (
    <form
      className={styles.card}
      aria-labelledby="coupon-create"
      data-testid="coupon-create"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!ready) return;
        setPending(true);
        setOutcome(null);
        const result = await createCoupon({
          code: code.trim(),
          nameEn: nameEn.trim(),
          nameHe: nameHe.trim() || null,
          discountType,
          percentOff: discountType === 'PERCENT' ? Number(percentOff) : null,
          amountOff: discountType === 'FIXED' ? amountOff.trim() : null,
          currency: discountType === 'FIXED' ? currency : null,
          defaultDurationMonths: monthsValue,
          maxRedemptions: maxValue,
          internalNote: note.trim() || null,
        });
        if (result.ok) {
          setCode('');
          setNameEn('');
          setNameHe('');
          setNote('');
        }
        setOutcome(
          result.ok ? { ok: true, text: t('done') } : { ok: false, text: refusal(result) },
        );
        setPending(false);
        router.refresh();
      }}
    >
      <h2 id="coupon-create" className={styles.cardTitle}>
        {t('title')}
      </h2>
      <div className={styles.assign}>
        <Input
          label={t('code')}
          value={code}
          dir="ltr"
          maxLength={32}
          placeholder="LAUNCH20"
          onChange={(event) => setCode(event.target.value.toUpperCase())}
        />
        <Input
          label={t('nameEn')}
          value={nameEn}
          onChange={(event) => setNameEn(event.target.value)}
        />
        <Input
          label={t('nameHe')}
          value={nameHe}
          onChange={(event) => setNameHe(event.target.value)}
        />
      </div>
      <div className={styles.assign}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t('type')}</span>
          <select
            className={styles.select}
            value={discountType}
            onChange={(event) => setDiscountType(event.target.value as 'PERCENT' | 'FIXED')}
            data-testid="coupon-type"
          >
            <option value="PERCENT">{t('percent')}</option>
            <option value="FIXED">{t('fixed')}</option>
          </select>
        </label>
        {discountType === 'PERCENT' ? (
          <Input
            label={t('percentOff')}
            inputMode="numeric"
            value={percentOff}
            onChange={(event) => setPercentOff(event.target.value)}
          />
        ) : (
          <>
            <Input
              label={t('amountOff')}
              inputMode="decimal"
              value={amountOff}
              onChange={(event) => setAmountOff(event.target.value)}
            />
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{t('currency')}</span>
              <select
                className={styles.select}
                value={currency}
                onChange={(event) => setCurrency(event.target.value)}
                data-testid="coupon-currency"
              >
                <option value="ILS">ILS</option>
                <option value="USD">USD</option>
              </select>
            </label>
          </>
        )}
        <Input
          label={t('months')}
          inputMode="numeric"
          value={months}
          placeholder={t('monthsNone')}
          error={isWhole(monthsValue) ? undefined : t('wholeMonths')}
          onChange={(event) => setMonths(event.target.value)}
        />
        <Input
          label={t('max')}
          inputMode="numeric"
          value={maxRedemptions}
          placeholder={t('maxNone')}
          error={isWhole(maxValue) ? undefined : t('wholeNumber')}
          onChange={(event) => setMaxRedemptions(event.target.value)}
        />
      </div>
      <Input
        label={t('note')}
        value={note}
        placeholder={t('notePlaceholder')}
        onChange={(event) => setNote(event.target.value)}
      />
      {example ? (
        <p className={styles.confirmSentence} data-testid="coupon-example">
          {monthsValue
            ? t('exampleFor', { price: ils(EXAMPLE_PRICE), example, months: monthsValue })
            : t('exampleOpen', { price: ils(EXAMPLE_PRICE), example })}
        </p>
      ) : null}
      <span className={styles.confirmActions}>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={!ready || pending}
          data-testid="coupon-create-submit"
        >
          {pending ? t('creating') : t('submit')}
        </Button>
      </span>
      {outcome ? (
        <p
          className={outcome.ok ? styles.done : styles.refused}
          role={outcome.ok ? 'status' : 'alert'}
          data-testid="coupon-create-outcome"
        >
          {outcome.text}
        </p>
      ) : null}
    </form>
  );
}
