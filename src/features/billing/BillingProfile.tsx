import { getTranslations } from 'next-intl/server';

import {
  hasSomethingToCharge,
  profileReading,
  type BillingProfile as Profile,
  type PaymentMethod,
} from '@/api/contracts/billing-profile';

import styles from './Billing.module.css';

/**
 * Screen 17e — who the bill is made out to, and what it charges.
 *
 * ── THE FACT THIS SCREEN EXISTS TO SURFACE ──
 * This tenant has **no payment method on file and four FAILED invoices.**
 * Those two are stated together, because a card that does not exist cannot
 * be charged — that is arithmetic rather than a diagnosis, and it is the
 * only actionable thing on the page.
 *
 * The screen does not claim it is *the* reason all four failed; Backend owns
 * that. It says there is nothing to charge, which is not in doubt.
 *
 * ── AND NO PROFILE IS NOT AN EMPTY PROFILE ──
 * A tenant that never entered billing details has no row. Rendering blank
 * fields for both states would tell someone whose details were deleted that
 * they had never filled them in.
 *
 * ── WHAT THE DESIGN ASKS FOR AND IS NOT THERE ──
 * **Invoice recipients (plural), a PO number, and a profile language.**
 * `billingEmail` is one address, so *"send invoices to finance@ and to the
 * owner"* is not expressible — and a second field that quietly overwrote the
 * first would be worse than none.
 */
export async function BillingProfileSection({
  profile,
  methods,
  failedInvoiceCount,
}: {
  readonly profile: Profile | null;
  readonly methods: readonly PaymentMethod[] | null;
  readonly failedInvoiceCount: number;
}) {
  const t = await getTranslations('billing');
  const reading = profileReading(profile);

  const nothingToCharge = methods !== null && !hasSomethingToCharge(methods);

  return (
    <div className={styles.block} data-testid="billing-profile">
      {/*
        Stated first, and stated together. Four charges failed against an
        entity with nothing to charge them to.
      */}
      {nothingToCharge ? (
        <p className={styles.noCard} data-testid="nothing-to-charge">
          {failedInvoiceCount > 0
            ? t('profile.noCardWithFailures', { count: failedInvoiceCount })
            : t('profile.noCard')}
        </p>
      ) : null}

      {methods !== null && methods.length > 0 ? (
        <p className={styles.card} data-testid="payment-method">
          {t('profile.card', {
            brand: methods[0]!.brand ?? t('profile.unknownBrand'),
            last4: methods[0]!.last4 ?? '????',
          })}
        </p>
      ) : null}

      {/*
        FOUR facts, not one blank form.

        `billingIdentity()` used to return `profile ?? empty`, collapsing all
        of these a layer below the screen where nothing here could see it.
        Backend now sends `state`, and the route's own comment names the
        fourth: "`present` with every field null means EMPTIED, which is a
        different thing from `no_billing_profile` and must read differently."

        The first one is the sharpest: with no billable entity, "add your
        billing details" is not even the right instruction — there is nothing
        to add them to.
      */}
      {reading === 'no_account' ? (
        <p className={styles.profileNone} data-testid="profile-no-account">
          {t('profile.noAccount')}
        </p>
      ) : reading === 'never_entered' ? (
        <p className={styles.profileNone} data-testid="profile-none">
          {t('profile.neverEntered')}
        </p>
      ) : reading === 'emptied' ? (
        <p className={styles.profileNone} data-testid="profile-blank">
          {t('profile.emptied')}
        </p>
      ) : (
        <dl className={styles.profileFields} data-testid="profile-fields">
          <Field label={t('profile.name')} value={profile?.billingName ?? null} />
          <Field label={t('profile.email')} value={profile?.billingEmail ?? null} />
          <Field label={t('profile.vatId')} value={profile?.vatId ?? null} />
          <Field label={t('profile.address')} value={profile?.billingAddress ?? null} />
        </dl>
      )}

      {/*
        Named rather than drawn, the same as the grant expiry on 12e.
      */}
      <p className={styles.profileAbsent} data-testid="profile-absent-fields">
        {t('profile.absentFields')}
      </p>
    </div>
  );
}

function Field({ label, value }: { readonly label: string; readonly value: string | null }) {
  if (value === null) return null;
  return (
    <div className={styles.profileField}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
