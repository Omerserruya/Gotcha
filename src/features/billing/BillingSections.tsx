import { getLocale, getTranslations } from 'next-intl/server';

import {
  failedInvoices,
  receiptAbsence,
  receiptHref,
  totalAmount,
  type Invoice,
} from '@/api/contracts/invoices';

import styles from './Billing.module.css';

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
 * search for an `/api/billing` mount returns nothing - the comment was
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
 * would be asserting billing behaviour from a mockup - and **a wrong claim
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
                read `href={invoice.providerPdfUrl ?? '#'}` - a string the
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
                counted as verified. Two guards, one test - the outer one means
                the inner is never exercised.
              */}
              {/*
                ★ BOTH, NOT EITHER. `absence` carries the PAID rule; `receipt`
                carries the safety one. Testing only the second would show a
                receipt link on a FAILED invoice that happened to carry a URL -
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
