import { getLocale, getTranslations } from 'next-intl/server';

import {
  planNameFor,
  type Plan,
  type Subscription,
  type UsageBreakdown,
} from '@/api/contracts/billing';

import {
  failedInvoices,
  receiptAbsence,
  receiptHref,
  totalAmount,
  type Invoice,
} from '@/api/contracts/invoices';

import { isStillPending } from '@/api/contracts/pricing';
import { Link } from '@/i18n/navigation';

import styles from './Billing.module.css';

/**
 * The plan, its price, and when it renews.
 *
 * **The currency is whatever the subscription carries** — the demo tenant is
 * charged `$1,499.00 USD`, not the design's `₪1,290`. That number is a mockup,
 * and converting it or showing a symbol the row does not have would put a
 * price in front of somebody that nobody agreed to.
 *
 * `cancelAtPeriodEnd` and a scheduled `pendingChange` are both rendered,
 * because "renews on the 8th" and "ends on the 8th" are opposite facts that
 * would otherwise look identical.
 */
export async function PlanLine({
  subscription,
  plans,
}: {
  readonly subscription: Subscription | null;
  readonly plans: readonly Plan[];
}) {
  const t = await getTranslations('billing');
  const locale = await getLocale();

  if (!subscription) {
    return (
      <p className={styles.unavailable} data-testid="plan-unavailable">
        {t('plan.unavailable')}
      </p>
    );
  }

  const day = new Intl.DateTimeFormat(locale, { dateStyle: 'long' });
  const price =
    subscription.snapshotPrice != null && subscription.snapshotCurrency
      ? new Intl.NumberFormat(locale, {
          style: 'currency',
          currency: subscription.snapshotCurrency,
          maximumFractionDigits: 0,
        }).format(Number(subscription.snapshotPrice))
      : null;

  return (
    <div className={styles.plan} data-testid="plan">
      <p className={styles.planLine} data-testid="plan-line">
        {/*
          The plan's NAME, not its key. `ai_voice` is a machine identifier and
          the most prominent line on a billing screen is the worst place for
          one — the same class of error as rendering a cuid as an object name.
          It is also translatable, which a key can never be.

          Falls back to the key only when the plan is not in the list at all:
          an unrecognised plan is still the one they are paying for, and a
          blank where the plan name belongs would be worse.
        */}
        <span className={styles.planName} data-testid="plan-name">
          {planNameFor(plans, subscription.planKey, locale) ?? subscription.planKey}
        </span>
        {price ? <span className={styles.planPrice}>{price}</span> : null}
        {subscription.currentPeriodEnd ? (
          <span className={styles.planRenews}>
            {/*
              Ending and renewing are opposite facts about the same date, and
              a line that says only "12 September" tells you neither.
            */}
            {subscription.cancelAtPeriodEnd
              ? t('plan.endsOn', { date: day.format(new Date(subscription.currentPeriodEnd)) })
              : t('plan.renewsOn', { date: day.format(new Date(subscription.currentPeriodEnd)) })}
          </span>
        ) : null}
      </p>

      {/*
        `isStillPending`, not a truthiness check on the object.

        The scheduler MARKS `appliedAt` and never deletes the row
        (`subscription.service.ts:524`), and `getSubscriptionForTenant` loads
        the relation unconditionally — so a change applied a year ago arrives
        on every response looking exactly like one that has not happened.

        This line used to read `pendingChange?.targetPlanKey`, which would
        have gone on saying "Changes to Foundation at renewal" every day after
        it already changed to Foundation. Found while reading the same table
        for 17b; nothing on this screen could have surfaced it, because the
        field it turns on was not in our contract.
      */}
      {isStillPending(subscription.pendingChange) && subscription.pendingChange?.targetPlanKey ? (
        <p className={styles.planNote} data-testid="plan-pending">
          {t('plan.changesAtRenewal', {
            // The scheduled plan gets the same treatment as the current one.
            plan:
              planNameFor(plans, subscription.pendingChange.targetPlanKey, locale) ??
              subscription.pendingChange.targetPlanKey,
          })}
        </p>
      ) : null}
      {/* 02's "Change plan" (17b), beside what you are on. */}
      <Link href="/settings/billing/plan" className={styles.planChange} data-testid="plan-change">
        {t('plan.change')}
      </Link>
    </div>
  );
}

/**
 * *"Where the month went."*
 *
 * Contracted and not yet served. Every piece exists — `Conversation.handledBy`
 * for the split, `Broadcast` for outbound, `VoiceCallSession` for minutes —
 * and nothing aggregates them.
 *
 * Each figure is independently nullable, because they come from different
 * places and a backend that can answer three of four should be able to say so.
 * A missing figure is omitted rather than shown as zero: "no outbound
 * messages" and "we did not count" are different, and on a billing screen the
 * difference is money.
 */
export async function UsageBreakdownSection({
  breakdown,
}: {
  readonly breakdown: UsageBreakdown | null;
}) {
  const t = await getTranslations('billing');
  const locale = await getLocale();

  if (!breakdown) {
    return (
      <p className={styles.unavailable} data-testid="breakdown-unavailable">
        {t('breakdown.unavailable')}
      </p>
    );
  }

  const number = new Intl.NumberFormat(locale);
  const rows: { key: string; label: string; value: string }[] = [];

  if (breakdown.handledByAi != null) {
    rows.push({
      key: 'ai',
      label: t('breakdown.byAi'),
      value: number.format(breakdown.handledByAi),
    });
  }
  if (breakdown.handledByPeople != null) {
    rows.push({
      key: 'people',
      label: t('breakdown.byPeople'),
      value: number.format(breakdown.handledByPeople),
    });
  }
  if (breakdown.outboundMessages != null) {
    rows.push({
      key: 'outbound',
      label: t('breakdown.outbound'),
      value: number.format(breakdown.outboundMessages),
    });
  }
  if (breakdown.voiceMinutes != null) {
    rows.push({
      key: 'voice',
      label: t('breakdown.voiceMinutes'),
      value:
        breakdown.voiceMinutesLimit != null
          ? t('breakdown.ofLimit', {
              used: number.format(breakdown.voiceMinutes),
              limit: number.format(breakdown.voiceMinutesLimit),
            })
          : number.format(breakdown.voiceMinutes),
    });
  }

  if (rows.length === 0) {
    return (
      <p className={styles.empty} data-testid="breakdown-empty">
        {t('breakdown.empty')}
      </p>
    );
  }

  return (
    <ul className={styles.rows} data-testid="breakdown">
      {rows.map((row) => (
        <li key={row.key} className={styles.row} data-testid={`breakdown-${row.key}`}>
          <span className={styles.rowLabel}>{row.label}</span>
          <span className={styles.rowValue}>{row.value}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Invoices.
 *
 * ── THE ROUTE WAS HERE ALL ALONG ──
 * This section used to say *"We can't show your invoices yet"*, beside a
 * comment reading *"no tenant-facing list route exists. Four real invoices
 * sit on the demo tenant, unreachable."*
 *
 * **`GET /api/billing/invoices` is mounted and serving**, and has been. Every
 * billing router mounts at bare `/api` and declares its own full path, so a
 * search for an `/api/billing` mount returns nothing — the comment was
 * precise, confident and wrong, which is the combination that gets believed.
 *
 * And what it hid is the point: **four invoices, every one FAILED, $5,996.**
 * A merchant was being told a feature was missing while four of their
 * charges had not gone through.
 *
 * ── A FAILED INVOICE HAS NO RECEIPT, AND THE SCREEN SAYS WHY ──
 * `providerPdfUrl` is written in the same update that sets `PAID`. So a
 * missing link on a failed invoice is the system being consistent, and a
 * blank where a link belongs would read as a document that went astray.
 *
 * ── STILL ABSENT ──
 * The overage sentence and the spending cap are not softened here: there is
 * no rate field on this route, so *"bills ₪0.40 per extra conversation"*
 * would be asserting billing behaviour from a mockup — and **a wrong claim
 * about money belongs least of all on the billing screen.**
 */
export async function Invoices({ invoices }: { readonly invoices: readonly Invoice[] | null }) {
  const t = await getTranslations('billing');
  const locale = await getLocale();

  if (invoices === null) {
    return (
      <p className={styles.unavailable} data-testid="invoices-unavailable">
        {t('invoices.unavailable')}
      </p>
    );
  }

  if (invoices.length === 0) {
    return (
      <p className={styles.unavailable} data-testid="invoices-empty">
        {t('invoices.empty')}
      </p>
    );
  }

  const failed = failedInvoices(invoices);
  const day = new Intl.DateTimeFormat(locale, { dateStyle: 'long' });

  return (
    <div className={styles.block} data-testid="invoices">
      {/*
        The thing a merchant most needs from this screen, above the list.
        Four charges that did not go through is not a row in a table.
      */}
      {failed.length > 0 ? (
        <p className={styles.invoicesFailed} data-testid="invoices-failed">
          {t('invoices.failedSummary', {
            count: failed.length,
            total: totalAmount(failed),
            currency: failed[0]!.currency,
          })}
        </p>
      ) : null}

      <ul className={styles.invoiceList}>
        {invoices.map((invoice) => {
          const absence = receiptAbsence(invoice);
          const receipt = receiptHref(invoice);
          const when = invoice.issuedAt ?? invoice.createdAt;
          return (
            <li key={invoice.id} className={styles.invoice} data-testid={`invoice-${invoice.id}`}>
              <span className={styles.invoiceWhen}>
                {when ? day.format(new Date(when)) : t('invoices.undated')}
              </span>
              <span className={styles.invoiceAmount}>
                {invoice.amount} {invoice.currency}
              </span>
              <span className={styles.invoiceStatus} data-status={invoice.status}>
                {t(`invoices.status.${invoice.status}` as 'invoices.status.PAID')}
              </span>

              {/*
                Why there is no receipt, rather than a blank that reads as a
                lost document. `providerPdfUrl` is written with PAID.

                ★★ AND THE LINK IS THE VALIDATED ONE, NOT THE RAW FIELD. This
                read `href={invoice.providerPdfUrl ?? '#'}` — a string the
                payment provider wrote, straight into an `href`, with the guard
                for exactly that sitting unused two directories away. The `??
                '#'` was dead, because the branch already required a URL; it is
                gone rather than left as a fallback that renders a link which
                does nothing.

                ⚠ AND NO TEST CAN SEE THIS HALF OF THE FIX. Restoring the raw
                `href` here as a mutation leaves every assertion green, because
                `receiptAbsence` now consults the same guard and this branch
                never runs for a value it would refuse. The security property
                lives in the contract; what is here is the type narrowing plus
                defence in depth, and it is recorded as untested rather than
                counted as verified. Two guards, one test — the outer one means
                the inner is never exercised.
              */}
              {/*
                ★ BOTH, NOT EITHER. `absence` carries the PAID rule; `receipt`
                carries the safety one. Testing only the second would show a
                receipt link on a FAILED invoice that happened to carry a URL —
                contractually possible, and a charge that did not go through is
                the last row to hand somebody a receipt for.
              */}
              {absence === null && receipt !== null ? (
                <a className={styles.invoiceReceipt} href={receipt}>
                  {t('invoices.receipt')}
                </a>
              ) : (
                <span className={styles.invoiceNoReceipt} data-testid={`no-receipt-${invoice.id}`}>
                  {t(
                    `invoices.noReceipt.${absence ?? 'unusable'}` as 'invoices.noReceipt.not_paid',
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
