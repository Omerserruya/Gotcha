'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import type { BillingProfile } from '@/api/contracts/billing-profile';
import { useRouter } from '@/i18n/navigation';

import { saveBillingProfile, type BillingDetails } from './actions';
import styles from './Billing.module.css';
import { PROFILE_FORM_ID } from './profile-form';

/**
 * 17e's details, editable - "Tax invoice made out to" and "Send invoices and
 * receipts to" (released 2026-10-08: the route is database only, no provider call).
 *
 * Seeded with what is stored; every field is sent on Save, because the route
 * replaces all five - an emptied field is cleared, on purpose. The two fields
 * 02 draws that have no column stay "-", with why.
 */
export function ProfileForm({ profile }: { readonly profile: BillingProfile }) {
  const t = useTranslations('billing.profile');
  const router = useRouter();
  const [details, setDetails] = useState<BillingDetails>({
    billingName: profile.billingName ?? '',
    vatId: profile.vatId ?? '',
    billingAddress: profile.billingAddress ?? '',
    billingCountry: profile.billingCountry ?? '',
    billingEmail: profile.billingEmail ?? '',
  });
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const field = (key: keyof BillingDetails, label: string, extra: Record<string, unknown> = {}) => (
    <label className={styles.detailsField}>
      <span className={styles.detailsLabel}>{label}</span>
      <input
        className={styles.detailsInput}
        value={details[key]}
        dir="auto"
        disabled={isPending}
        data-testid={`profile-input-${key}`}
        onChange={(e) => {
          setSaid(null);
          setDetails({ ...details, [key]: e.target.value });
        }}
        {...extra}
      />
    </label>
  );

  return (
    <form
      id={PROFILE_FORM_ID}
      aria-busy={isPending}
      data-testid="profile-form"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const done = await saveBillingProfile(details);
          if (done.ok) {
            setSaid({ ok: true, text: t('saved') });
            router.refresh();
          } else {
            setSaid({ ok: false, text: t(`saveRefused.${done.reason}`) });
          }
        });
      }}
    >
      <div className={styles.detailsFields} data-testid="profile-fields">
        {field('billingName', t('legalName'), { maxLength: 200 })}
        {field('vatId', t('vatId'), { maxLength: 40 })}
        {field('billingAddress', t('address'), { maxLength: 300 })}
        {field('billingCountry', t('country'), {
          maxLength: 2,
          placeholder: 'IL',
          autoCapitalize: 'characters',
          dir: 'ltr',
        })}
        {/* 02's two more fields have no column: "-", and why. */}
        <span className={styles.detailsField}>
          <span className={styles.detailsLabel}>{t('po')}</span>
          <span className={styles.detailsBox} title={t('noField')}>
            -
          </span>
        </span>
        <span className={styles.detailsField}>
          <span className={styles.detailsLabel}>{t('language')}</span>
          <span className={styles.detailsBox} title={t('noField')}>
            -
          </span>
        </span>
      </div>
      <h3 className={styles.lowHeading}>{t('sendTo')}</h3>
      {field('billingEmail', t('email'), { type: 'email', maxLength: 200, dir: 'ltr' })}
      {said ? (
        <p
          className={said.ok ? styles.profileSaved : styles.profileProblem}
          role={said.ok ? 'status' : 'alert'}
          data-testid={said.ok ? 'profile-saved' : 'profile-problem'}
        >
          {said.text}
        </p>
      ) : null}
    </form>
  );
}
