import { getTranslations } from 'next-intl/server';

import {
  cardExpiry,
  hasSomethingToCharge,
  profileReading,
  type BillingProfile as Profile,
  type PaymentMethod,
} from '@/api/contracts/billing-profile';

import styles from './Billing.module.css';
import { billingWritesEnabled } from '@/api/client/billing-writes';
import { HeldConfirm } from './HeldConfirm';
import { ProfileForm } from './ProfileForm';

/**
 * Screen 17e - who the bill is made out to, and what it charges.
 *
 * ── THE FACT THIS SCREEN EXISTS TO SURFACE ──
 * This tenant has **no payment method on file and four FAILED invoices.**
 * Those two are stated together, because a card that does not exist cannot
 * be charged - that is arithmetic rather than a diagnosis, and it is the
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
 * owner"* is not expressible - and a second field that quietly overwrote the
 * first would be worse than none.
 */
export async function BillingProfileSection({
  profile,
  methods,
  failedInvoiceCount,
}: {
  readonly profile: Profile | null;
  readonly methods: readonly PaymentMethod[] | null;
  /**
   * How many charges have already failed - **`null` means we could not find
   * out**, which is not zero.
   *
   * It used to be a plain `number`, defaulted from `invoices ?? []`. A failed
   * invoices read therefore produced 0, and the sentence quietly demoted
   * itself from *"and 4 charges have already failed"* to *"there's nothing to
   * charge"* - dropping the half that makes it urgent, with nothing to
   * indicate anything was missing.
   */
  readonly failedInvoiceCount: number | null;
}) {
  const t = await getTranslations('billing');
  const reading = profileReading(profile);
  // Off here: the environment's reason. On: no card session is wired yet - said so.
  const live = billingWritesEnabled();

  const nothingToCharge = methods !== null && !hasSomethingToCharge(methods);

  const card = methods !== null && methods.length > 0 ? methods[0]! : null;

  /*
    17e, measured: Payment method; "Tax invoice made out to" as 02's fields;
    "Send invoices and receipts to". Read state - the values as stored, in
    02's boxes, and nothing here writes yet.
  */
  return (
    <div className={styles.detailsDrawer} data-testid="billing-profile">
      <h3 className={styles.lowHeading}>{t('profile.paymentMethod')}</h3>
      {card ? (
        <div className={styles.detailsCard} data-testid="payment-method">
          <span className={styles.detailsBrand} aria-hidden="true">
            {(card.brand ?? t('profile.unknownBrand')).toUpperCase()}
          </span>
          <span className={styles.detailsCardText}>
            {t('profile.card', {
              brand: card.brand ?? t('profile.unknownBrand'),
              last4: card.last4 ?? '????',
            })}
            {cardExpiry(card) ? (
              <span className={styles.detailsCardSub} data-testid="payment-method-expiry">
                {t('profile.expires', { date: cardExpiry(card)! })}
              </span>
            ) : null}
          </span>
          <HeldConfirm
            label={t('profile.replace')}
            className={styles.detailsAction}
            sentences={[
              t('held.replaceCard', {
                brand: card.brand ?? t('profile.unknownBrand'),
                last4: card.last4 ?? '????',
              }),
            ]}
            yes={t('held.toSecurePage')}
            heldTag={live ? t('held.tagNotBuilt') : t('held.tag')}
            heldWhy={live ? t('held.whyNotBuilt') : t('held.why')}
            cancel={t('held.cancel')}
            testid="replace-card"
          />
        </div>
      ) : (
        /*
          02's card row in every state: "No card on file" when the read said
          so, "-" when it could not say. The sentence below says the rest.
        */
        <div
          className={styles.detailsCard}
          data-testid="payment-method-none"
          title={methods === null ? t('profile.methodsUnknown') : undefined}
        >
          <span className={styles.detailsBrand} aria-hidden="true" />
          <span className={styles.detailsCardText}>
            {methods === null ? '-' : t('profile.noCardRow')}
          </span>
          <HeldConfirm
            label={t('profile.addCard')}
            className={styles.detailsAction}
            sentences={[t('held.addCard')]}
            yes={t('held.toSecurePage')}
            heldTag={live ? t('held.tagNotBuilt') : t('held.tag')}
            heldWhy={live ? t('held.whyNotBuilt') : t('held.why')}
            cancel={t('held.cancel')}
            testid="add-card"
          />
        </div>
      )}

      {/*
        ════════════════════════════════════════════════════════════════════
        THE MOST CONSEQUENTIAL SENTENCE ON THIS SCREEN, AND IT USED TO
        VANISH SILENTLY.
        ════════════════════════════════════════════════════════════════════
        This block depends on TWO parallel reads, and it failed roughly one
        capture in six - a different viewport each time, with a clear request
        budget. The condition was `methods !== null && ...`, so when the
        payment-methods fetch lost, the whole warning disappeared and the page
        looked complete.

        A merchant reloading saw "there's no payment method on file, and 4
        charges have already failed" most of the time, and sometimes saw
        nothing at all, with no indication anything was missing.

        Both reads now have a sentence. An unread fact and an absent one are
        different, and on a billing screen the difference is whether somebody
        knows to look again.
      */}
      {methods === null ? (
        <p className={styles.noCard} data-testid="methods-unknown">
          {t('profile.methodsUnknown')}
        </p>
      ) : nothingToCharge ? (
        <p className={styles.noCard} data-testid="nothing-to-charge">
          {failedInvoiceCount === null
            ? /*
                There IS no payment method - that much we read successfully -
                but we could not count the failures. Said rather than rounded
                to zero, because zero is the reassuring answer and it is one
                we do not have.
              */
              t('profile.failuresUnknown')
            : failedInvoiceCount > 0
              ? t('profile.noCardWithFailures', { count: failedInvoiceCount })
              : t('profile.noCard')}
        </p>
      ) : null}

      <h3 className={styles.lowHeading}>{t('profile.invoiceTo')}</h3>
      {/*
        FOUR facts, not one blank form.

        `billingIdentity()` used to return `profile ?? empty`, collapsing all
        of these a layer below the screen where nothing here could see it.
        Backend now sends `state`, and the route's own comment names the
        fourth: "`present` with every field null means EMPTIED, which is a
        different thing from `no_billing_profile` and must read differently."

        The first one is the sharpest: with no billable entity, "add your
        billing details" is not even the right instruction - there is nothing
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
      ) : null}
      {/*
        A billing record that exists is edited here (17e's Save, database
        only). With none yet, the boxes show what there is, read-only - the
        route has nothing to save into until a card is added.
      */}
      {profile?.state === 'present' ? (
        <ProfileForm profile={profile} />
      ) : (
        <>
          {/*
          02's boxes in every state - the values when there are any, "-" when
          there are none. What the state IS is the one line above.
        */}
          <div className={styles.detailsFields} data-testid="profile-fields">
            <Field label={t('profile.legalName')} value={profile?.billingName ?? null} />
            <Field label={t('profile.vatId')} value={profile?.vatId ?? null} />
            <Field label={t('profile.address')} value={profile?.billingAddress ?? null} />
            <Field label={t('profile.country')} value={profile?.billingCountry ?? null} />
            {/* 02's two more fields have no column: "-", and why. */}
            <Field label={t('profile.po')} value={null} none={t('profile.noField')} />
            <Field label={t('profile.language')} value={null} none={t('profile.noField')} />
          </div>
          <h3 className={styles.lowHeading}>{t('profile.sendTo')}</h3>
          <p
            className={styles.detailsChips}
            data-testid="profile-send-to"
            title={t('profile.absentFields')}
          >
            {profile?.billingEmail ? (
              <span className={styles.detailsChip}>{profile.billingEmail}</span>
            ) : (
              <span className={styles.lowNone}>-</span>
            )}
          </p>
        </>
      )}

      {/*
        Named rather than drawn, the same as the grant expiry on 12e.
      */}
      <p className="srOnly" data-testid="profile-absent-fields">
        {t('profile.absentFields')}
      </p>
    </div>
  );
}

function Field({
  label,
  value,
  none,
}: {
  readonly label: string;
  readonly value: string | null;
  /** Why there is no value, when the platform has no column for it. */
  readonly none?: string;
}) {
  return (
    <label className={styles.detailsField}>
      <span className={styles.detailsLabel}>{label}</span>
      <span className={styles.detailsBox} title={value === null ? none : undefined}>
        {value ?? '-'}
      </span>
    </label>
  );
}
