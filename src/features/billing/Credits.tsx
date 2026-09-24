import { getLocale, getTranslations } from 'next-intl/server';

import {
  awaitingGrant,
  consumptionIsTrustworthy,
  expiringAtRenewal,
  purchasedBalance,
  ranWithoutMetering,
  OBSERVED_WINDOW_DAYS,
  type CreditSummary,
} from '@/api/contracts/credits';

import styles from './Billing.module.css';

/**
 * Credits — screen 17c.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE USAGE BAR IS NOT DRAWN, AND THAT IS THE POINT OF THIS COMPONENT
 * ════════════════════════════════════════════════════════════════════════════
 * `consumedCredits` is `includedAllowance - includedRemaining`, so anything
 * that removes credits without spending them lands in it — and expiry removes
 * credits without spending them.
 *
 * Measured on this tenant: granted 7,000, **spent 340.01**, and 6,659.99
 * EXPIRED at renewal. The route reports `consumedCredits: 7000`,
 * `consumedPct: 100`.
 *
 * A bar at 100% tells an owner their AI burned the year's allowance in ten
 * days. A caveat underneath does not undo it: **a bar is a picture and a
 * caveat is a sentence, and people read pictures.** The belief is formed
 * before the caveat is reached.
 *
 * So `consumptionIsTrustworthy` withholds the figure — on a contradiction the
 * payload carries on its own face, not on a policy of distrust, and it lifts
 * the moment the route starts reporting real spend.
 * ════════════════════════════════════════════════════════════════════════════
 */
export async function CreditsSection({ credits }: { readonly credits: CreditSummary | null }) {
  const t = await getTranslations('billing.credits');
  const locale = await getLocale();

  if (!credits) {
    return (
      <p className={styles.unavailable} data-testid="credits-unavailable">
        {t('unavailable')}
      </p>
    );
  }

  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const day = new Intl.DateTimeFormat(locale, { dateStyle: 'long' });

  const expiring = expiringAtRenewal(credits);
  const purchased = purchasedBalance(credits);
  const observed = credits.observedRemaining;
  const renewsAt = credits.period.resetsAt ?? credits.period.endsAt;

  return (
    <div
      className={styles.credits}
      data-testid="credits"
      data-consumption={consumptionIsTrustworthy(credits, new Date()) ? 'shown' : 'withheld'}
    >
      {/*
        The cycle, above the number it bounds. The design puts it there and it
        is the difference between "14,640 credits" and "14,640 credits until
        12 October" — the second is a runway and the first is a quantity.
      */}
      {credits.period.startsAt && renewsAt ? (
        <p className={styles.creditsBasis} data-testid="credits-cycle">
          {t('cycle', {
            from: day.format(new Date(credits.period.startsAt)),
            to: day.format(new Date(renewsAt)),
          })}
        </p>
      ) : renewsAt ? (
        <p className={styles.creditsBasis} data-testid="credits-cycle">
          {t('cycleEnds', { to: day.format(new Date(renewsAt)) })}
        </p>
      ) : null}

      <p className={styles.creditsBalance} data-testid="credits-balance">
        {t('balance', { credits: number.format(credits.totalAvailableCredits) })}
      </p>

      {/*
        What the total is made of — the design's "12,640 of 20,000 plan
        credits + 2,000 top-up".

        Two departures. It does NOT carry "Used 7,360", because that figure is
        `consumedCredits` and counts expiry as spend: 7,360 used would be the
        same claim as the 100% bar this screen refuses to draw.

        And the purchased half is not called a "top-up kept until used".
        `CreditExpiryPolicy` has PERIOD_END, the summary route strips
        `expiresAt`, and permanence is a promise the screen cannot check.
      */}
      {credits.plan.includedCredits > 0 || purchased > 0 ? (
        <p className={styles.creditsNote} data-testid="credits-composition">
          {credits.plan.includedCredits > 0 && purchased > 0
            ? t('composition', {
                plan: number.format(expiring),
                included: number.format(credits.plan.includedCredits),
                purchased: number.format(purchased),
              })
            : credits.plan.includedCredits > 0
              ? t('compositionPlanOnly', {
                  plan: number.format(expiring),
                  included: number.format(credits.plan.includedCredits),
                })
              : t('compositionPurchasedOnly', { purchased: number.format(purchased) })}
        </p>
      ) : null}

      {/*
        The two buckets, which do NOT have the same fate. INCLUDED is gated on
        `periodKey` in `deriveBalanceFromLots` and dies at renewal; the rest
        does not — though not because the model forbids it, only because every
        package on sale is sold non-expiring. So the expiring half is named
        with its date and the other half is named without a promise.
      */}
      {expiring > 0 ? (
        <p className={styles.creditsNote} data-testid="credits-expiring">
          {renewsAt
            ? t('split.expiring', {
                credits: number.format(expiring),
                date: day.format(new Date(renewsAt)),
              })
            : t('split.expiringNoDate', { credits: number.format(expiring) })}
        </p>
      ) : null}

      {purchased > 0 ? (
        <p className={styles.creditsNote} data-testid="credits-purchased">
          {t('split.purchased', { credits: number.format(purchased) })}
        </p>
      ) : null}

      {/*
        A contracted allowance with nothing granted is not a spent one.

        This tenant's subscription is ACTIVE since 2026-09-08 for 7,000
        credits; the only lot ever issued expired on 2026-08-28 and the
        balance snapshot still names period 2026-07. "7,000 included" beside
        "0 remaining" reads as a loss unless somebody says which is the
        contract and which is the holding.
      */}
      {awaitingGrant(credits) ? (
        <div className={styles.creditsNotice} data-testid="credits-awaiting-grant">
          <p className={styles.creditsNoticeLead}>{t('awaitingGrant.lead')}</p>
          <p className={styles.creditsNote}>
            {t('awaitingGrant.body', {
              included: number.format(credits.plan.includedCredits),
              date: credits.period.startsAt ? day.format(new Date(credits.period.startsAt)) : '—',
            })}
          </p>
        </div>
      ) : null}

      {!consumptionIsTrustworthy(credits, new Date()) ? (
        <p className={styles.creditsNote} data-testid="credits-consumption-withheld">
          {/*
            Said plainly rather than omitted silently. A missing usage figure
            on a billing screen looks like a loading failure; this says it is
            a deliberate refusal and why.
          */}
          {t('consumption.withheld')}
        </p>
      ) : null}

      {/*
        TWO ESTIMATES, NEVER SUBSTITUTED.

        `estimatedRemaining` is the PLAN's published ratio. `observedRemaining`
        is this tenant's measured burn. The route ships both "each labelled
        with its basis" because "a screen that silently swapped them would make
        a pricing claim out of one customer's behaviour". So whichever is
        shown, the screen names which it is.
      */}
      {/*
        ★ AND NEITHER IS SHOWN WHILE THE PERIOD'S CREDITS HAVE NOT BEEN
        GRANTED.

        Both estimates divide a BALANCE by a rate. While `awaitingGrant()`,
        that balance is zero for a reason the two paragraphs above spend
        their whole length explaining — the grant has not happened, and this
        is not credit anybody spent. Rendering "about 0 more conversations"
        underneath is a forecast from an input the screen has just disowned,
        and it is worse than the estimate standing alone: by that point the
        reader has been taught to trust this screen's carefulness, so they
        read the 0 as a measurement.

        Same shape as 13e's "0 of 0 conversations read is not progress — it
        is a pipeline that has not started counting", and the same answer.
        A forecast from an ungranted allowance is not a small forecast; it is
        not a forecast. So the estimate is withheld and the screen says it
        comes back when the credits are granted — which also tells somebody
        that nothing here is broken.
      */}
      {awaitingGrant(credits) ? (
        <p className={styles.creditsBasis} data-testid="credits-estimate-withheld">
          {t('estimate.awaitingGrant')}
        </p>
      ) : observed.chats != null && observed.basis === 'TENANT_ACTUAL' ? (
        <div className={styles.creditsEstimate} data-testid="credits-estimate-observed">
          <p className={styles.creditsNote}>
            {t('estimate.observed', { chats: number.format(observed.chats) })}
          </p>
          <p className={styles.creditsBasis} data-testid="credits-estimate-basis">
            {t('estimate.observedBasis', { days: OBSERVED_WINDOW_DAYS })}
          </p>
          {observed.sample.conversationAttributedPct < 100 ? (
            <p className={styles.creditsBasis} data-testid="credits-attribution">
              {t('estimate.partiallyAttributed', {
                pct: observed.sample.conversationAttributedPct,
              })}
            </p>
          ) : null}
        </div>
      ) : credits.estimatedRemaining.chats != null ? (
        <div className={styles.creditsEstimate} data-testid="credits-estimate-plan">
          <p className={styles.creditsNote}>
            {t('estimate.plan', { chats: number.format(credits.estimatedRemaining.chats) })}
          </p>
          <p className={styles.creditsBasis} data-testid="credits-estimate-basis">
            {t('estimate.planBasis')}
          </p>
        </div>
      ) : null}

      {/*
        `no_consumption_recorded` arrives with `sample.conversations: 88`,
        because the service tests `creditsConsumed <= 0` BEFORE the sample
        gate. It is a statement about METERING, not activity — and rendering
        it as "no activity" would be a flat falsehood sitting next to the 88
        that disproves it.
      */}
      {ranWithoutMetering(credits) ? (
        <p className={styles.creditsBasis} data-testid="credits-no-metering">
          {t('observed.noMetering', {
            conversations: number.format(observed.sample.conversations),
            days: OBSERVED_WINDOW_DAYS,
          })}
        </p>
      ) : observed.reason === 'not_enough_conversations' ? (
        <p className={styles.creditsBasis} data-testid="credits-too-few">
          {t('observed.tooFewConversations', {
            conversations: number.format(observed.sample.conversations),
            days: OBSERVED_WINDOW_DAYS,
          })}
        </p>
      ) : null}
    </div>
  );
}
