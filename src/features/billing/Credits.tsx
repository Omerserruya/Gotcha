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
 * Credits left — 17's first card.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE USAGE BAR IS NOT DRAWN, AND THAT IS THE POINT OF THIS COMPONENT
 * (02's bar is drawn as holdings instead, and only when it can be believed)
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
  /*
    02 writes "12 Sep – 12 Oct". A cycle that crosses a year carries it, or a
    year-long period reads "8 Sep – 8 Sep".
  */
  const crossesYear =
    credits.period.startsAt != null &&
    (credits.period.resetsAt ?? credits.period.endsAt) != null &&
    new Date(credits.period.startsAt).getFullYear() !==
      new Date((credits.period.resetsAt ?? credits.period.endsAt)!).getFullYear();
  const day = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    ...(crossesYear ? { year: 'numeric' } : {}),
  });
  const longDay = new Intl.DateTimeFormat(locale, { dateStyle: 'long' });

  const expiring = expiringAtRenewal(credits);
  const purchased = purchasedBalance(credits);
  const observed = credits.observedRemaining;
  const renewsAt = credits.period.resetsAt ?? credits.period.endsAt;
  const trustworthy = consumptionIsTrustworthy(credits, new Date());
  const waiting = awaitingGrant(credits);

  /*
    02's bar, as HOLDINGS rather than spend: the plan's credits still held
    (dark) and those bought separately (violet), against what the cycle
    started with. It is drawn only when the payload's consumption can be
    believed and the period's credits have been granted — otherwise an empty
    bar is the same picture as the 100% this component refuses to draw.
  */
  const whole = credits.plan.includedCredits + purchased;
  const bar = trustworthy && !waiting && whole > 0;

  return (
    <div
      className={styles.credits}
      data-testid="credits"
      data-consumption={trustworthy ? 'shown' : 'withheld'}
    >
      <p className={styles.creditsHead}>
        <span>{t('left')}</span>
        {/*
          The cycle, above the number it bounds: "14,640 until 12 October" is a
          runway, and "14,640" alone is a quantity.
        */}
        {credits.period.startsAt && renewsAt ? (
          <span className={styles.creditsCycle} data-testid="credits-cycle">
            {t('cycle', {
              from: day.format(new Date(credits.period.startsAt)),
              to: day.format(new Date(renewsAt)),
            })}
          </span>
        ) : renewsAt ? (
          <span className={styles.creditsCycle} data-testid="credits-cycle">
            {t('cycleEnds', { to: day.format(new Date(renewsAt)) })}
          </span>
        ) : null}
      </p>

      <p className={styles.creditsFigure}>
        <span className={styles.creditsBalance} data-testid="credits-balance">
          {number.format(credits.totalAvailableCredits)}
        </span>
        {/*
          What the total is made of — 02's "12,640 of 20,000 plan credits +
          2,000 top-up". No "Used 7,360": that is `consumedCredits`, which
          counts expiry as spend. And the purchased half is "bought
          separately", never a "top-up kept until used": the summary route
          strips `expiresAt`, so permanence is a promise nothing here checks.
        */}
        {credits.plan.includedCredits > 0 || purchased > 0 ? (
          <span className={styles.creditsComposition} data-testid="credits-composition">
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
          </span>
        ) : null}
      </p>

      {bar ? (
        <div className={styles.creditsBar} aria-hidden="true" data-testid="credits-bar">
          <span
            className={styles.creditsBarPlan}
            style={{ inlineSize: `${(expiring / whole) * 100}%` }}
          />
          <span
            className={styles.creditsBarBought}
            style={{ inlineSize: `${(purchased / whole) * 100}%` }}
          />
        </div>
      ) : null}

      {/*
        The legend names the two halves, which do NOT share a fate: the plan's
        credits die at renewal; the bought ones are named without a promise.
      */}
      {expiring > 0 || purchased > 0 ? (
        <p className={styles.creditsLegend}>
          {expiring > 0 ? (
            <span className={styles.creditsKey} data-testid="credits-expiring">
              <span className={styles.creditsSwatchPlan} aria-hidden="true" />
              {renewsAt
                ? t('split.expiring', {
                    credits: number.format(expiring),
                    date: longDay.format(new Date(renewsAt)),
                  })
                : t('split.expiringNoDate', { credits: number.format(expiring) })}
            </span>
          ) : null}
          {purchased > 0 ? (
            <span className={styles.creditsKey} data-testid="credits-purchased">
              <span className={styles.creditsSwatchBought} aria-hidden="true" />
              {t('split.purchased', { credits: number.format(purchased) })}
            </span>
          ) : null}
        </p>
      ) : null}

      {/*
        A contracted allowance with nothing granted is not a spent one — "7,000
        included" beside "0" reads as a loss unless somebody says which is the
        contract and which is the holding.
      */}
      {waiting ? (
        <div className={styles.creditsNotice} data-testid="credits-awaiting-grant">
          <p className={styles.creditsNoticeLead}>{t('awaitingGrant.lead')}</p>
          <p className={styles.creditsNote}>
            {t('awaitingGrant.body', {
              included: number.format(credits.plan.includedCredits),
              date: credits.period.startsAt
                ? longDay.format(new Date(credits.period.startsAt))
                : '—',
            })}
          </p>
        </div>
      ) : null}

      {/*
        02's two translations of the number. TWO ESTIMATES, NEVER SUBSTITUTED:
        `observedRemaining` is this tenant's measured burn, `estimatedRemaining`
        the plan's published ratio, and the tile names which it is. Neither is
        shown while the period's credits have not been granted — both divide a
        balance the screen has just disowned, and "about 0 conversations" would
        be read as a measurement.
      */}
      <div className={styles.creditsTiles}>
        {waiting ? (
          <div className={styles.creditsTile} data-testid="credits-estimate-withheld">
            <p className={styles.creditsTileValue}>—</p>
            <p className={styles.creditsTileSub}>{t('estimate.awaitingGrant')}</p>
          </div>
        ) : observed.chats != null && observed.basis === 'TENANT_ACTUAL' ? (
          <div className={styles.creditsTile} data-testid="credits-estimate-observed">
            <p className={styles.creditsTileValue}>
              {t('estimate.conversations', { chats: number.format(observed.chats) })}
            </p>
            <p className={styles.creditsTileSub} data-testid="credits-estimate-basis">
              {observed.creditsPerConversation != null
                ? t('estimate.observedAverage', {
                    // A rate keeps its tenth: 7.5 is not 8.
                    avg: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
                      observed.creditsPerConversation,
                    ),
                    days: OBSERVED_WINDOW_DAYS,
                  })
                : t('estimate.observedBasis', { days: OBSERVED_WINDOW_DAYS })}
            </p>
          </div>
        ) : credits.estimatedRemaining.chats != null ? (
          <div className={styles.creditsTile} data-testid="credits-estimate-plan">
            <p className={styles.creditsTileValue}>
              {t('estimate.conversations', {
                chats: number.format(credits.estimatedRemaining.chats),
              })}
            </p>
            <p className={styles.creditsTileSub} data-testid="credits-estimate-basis">
              {t('estimate.planBasis')}
            </p>
          </div>
        ) : (
          <div className={styles.creditsTile} data-testid="credits-estimate-none">
            <p className={styles.creditsTileValue}>—</p>
          </div>
        )}
        {/*
          "Lasts until renewal" needs a projected run-out against the renewal
          date, and nothing computes one for credits: "—", and why on its title.
        */}
        <div className={styles.creditsTile} data-testid="credits-runout" title={t('runout.none')}>
          <p className={styles.creditsTileValue}>—</p>
          <p className={styles.creditsTileSub}>{t('runout.label')}</p>
        </div>
      </div>

      {observed.chats != null &&
      observed.basis === 'TENANT_ACTUAL' &&
      !waiting &&
      observed.sample.conversationAttributedPct < 100 ? (
        <p className={styles.creditsBasis} data-testid="credits-attribution">
          {t('estimate.partiallyAttributed', { pct: observed.sample.conversationAttributedPct })}
        </p>
      ) : null}

      {/*
        Said plainly rather than omitted: a missing usage figure on a billing
        screen looks like a loading failure; this says it is a refusal and why.
      */}
      {!trustworthy ? (
        <p className={styles.creditsBasis} data-testid="credits-consumption-withheld">
          {t('consumption.withheld')}
        </p>
      ) : null}

      {/*
        `no_consumption_recorded` arrives with conversations in the sample: a
        statement about METERING, not activity — "no activity" would be false
        beside the number that disproves it.
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
