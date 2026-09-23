'use client';

import { useTranslations } from 'next-intl';

import { isEnabled } from '@/permissions/capability';
import { useCapability } from '@/permissions/permissions-context';

import styles from './Billing.module.css';

/**
 * What changing the plan would actually do, and whether you may.
 *
 * ── WHY THIS IS PROSE AND NOT A BUTTON ──
 * Every plan available to this tenant is cheaper than theirs, so every change
 * is the **deferred** kind: `changePlan` writes a `PendingSubscriptionChange`
 * and *"the current plan, its features, its limits and its credits all stay
 * exactly as they are"* until the period ends. On an annual subscription that
 * is eleven and a half months away.
 *
 * A control that reads "Change plan" and silently means "in September 2027"
 * is the kind of thing somebody clicks twice and then telephones about. The
 * date comes first; the control follows it.
 *
 * ── THE PERMISSION IS `disable`, NOT `hide` ──
 * `/pricing/change` is gated on `settings:billing:manage`. Hiding the control
 * from someone without it leaves them looking for a feature they were told
 * exists; disabling it with the reason lets them ask the right person. That is
 * the distinction `useCapability` was built around, and this is a workflow
 * rather than navigation, so it takes the workflow side.
 *
 * When permissions could not be loaded at all, `canSee` answers true and the
 * control renders. The backend is still the authority — the worst case is a
 * refusal with an explanation, which beats a product that looks like it lost
 * a feature.
 */
export function ChangePlanGate({
  effectiveAt,
  hasPaymentMethod,
}: {
  readonly effectiveAt: string | null;
  /**
   * An upgrade charges the prorated difference BEFORE granting anything, and
   * resolves the card as `paymentMethods[0]?.id ?? "nocard"`. With none, it is
   * declined having changed nothing.
   */
  readonly hasPaymentMethod: boolean;
}) {
  const t = useTranslations('billing.pricing');
  const capability = useCapability('settings:billing:manage', 'disable');

  return (
    <div className={styles.changeNotes} data-testid="change-notes">
      {effectiveAt ? (
        <p className={styles.changeNote} data-testid="change-deferred">
          {/*
            The YEAR is not optional. Eleven and a half months out, "8
            September" is read as this year by everybody who sees it.
          */}
          {t('change.deferred', {
            date: new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(
              new Date(effectiveAt),
            ),
          })}
        </p>
      ) : null}

      {/*
        ★ SAID BEFORE THE CHOICE, AND BEFORE THE CONTROL EXISTS.
        ════════════════════════════════════════════════════════════════════
        `resumeSubscription` is the only revoke path in the platform, and its
        cleanup is gated:

          deleteMany({ where: { subscriptionId, changeType: "CANCEL",
                                appliedAt: null } })

        So a scheduled CANCEL can be called off and a scheduled DOWNGRADE or
        VOLUME_CHANGE cannot. `changePlan` upserts the same row, so choosing
        something else REPLACES the scheduled change — but nothing returns the
        subscription to having none.

        "Cannot be undone" would be too blunt and slightly wrong. The true
        shape is: replaceable, never clearable. Said here rather than after
        the click, because it is not obvious, it is permanent, and it is
        exactly the kind of thing a person discovers at the wrong moment.

        Rendered even though this screen has no control yet: the sentence is
        true today about a state the tenant could already be in, and it is not
        contingent on us shipping the button.
      */}
      <p className={styles.changeNote} data-testid="change-irreversible">
        {t('change.irreversible')}
      </p>

      {!hasPaymentMethod ? (
        <p className={styles.changeNote} data-testid="change-no-card">
          {/*
            Said as a path, not a warning. The idempotency key is scoped to the
            payment method deliberately, "so a failed attempt must not
            permanently block a retry after the customer adds a valid card" —
            so add-a-card-then-upgrade genuinely works.
          */}
          {t('change.noCard')}
        </p>
      ) : null}

      {!isEnabled(capability) ? (
        <p className={styles.changeNote} data-testid="change-needs-permission">
          {t('change.needsPermission')}
        </p>
      ) : null}
    </div>
  );
}
