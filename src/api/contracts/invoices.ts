import { z } from 'zod';

/**
 * Invoices — screen 17.
 *
 * `GET /api/billing/invoices` → **`{ invoices }`**, a fifth envelope shape on
 * this platform after `{ data }`, `{ data, nextCursor }`, a bare array and a
 * bare `{ subscription }`.
 *
 * ── THIS ROUTE WAS HERE ALL ALONG ──
 * The registry pointed at `/api/billing/summary`, annotated *"contracted, not
 * yet served"*, and the screen said *"We can't show your invoices yet."* The
 * comment beside it read: *"no tenant-facing list route exists. Four real
 * invoices sit on the demo tenant, unreachable."*
 *
 * **All of that was written in good faith and was wrong.** `invoices.ts` is
 * mounted — at bare `/api`, like every billing router, which is why searching
 * for an `/api/billing` mount finds nothing.
 *
 * And what it was hiding is not cosmetic: **four invoices, every one FAILED,
 * $5,996 in total.** A merchant was being told a feature was missing while
 * four of their charges had not gone through.
 *
 * ── A FAILED INVOICE HAS NO RECEIPT, AND THAT IS NOT A GAP ──
 * `providerPdfUrl` is written in the same update that sets `PAID`. Measured
 * across every invoice on this machine:
 * ```
 * PAID    5   with a PDF  5
 * DRAFT   6   with a PDF  0
 * FAILED 14   with a PDF  0
 * ```
 * **The correlation is exact.** So a missing receipt on a failed invoice is
 * the system being consistent, and the screen says *why* there is no link
 * rather than leaving a blank that implies one went astray.
 */

export const INVOICE_STATUSES = ['DRAFT', 'ISSUED', 'PAID', 'FAILED', 'VOID'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const invoiceSchema = z.object({
  id: z.string().min(1),
  type: z.string().default(''),
  status: z.enum(INVOICE_STATUSES).catch('DRAFT'),
  /** A decimal string from the route — never parsed to a float. */
  amount: z.string().default('0'),
  currency: z.string().default('ILS'),
  issuedAt: z.string().nullable().default(null),
  paidAt: z.string().nullable().default(null),
  providerInvoiceRef: z.string().nullable().default(null),
  /** Present only on a PAID invoice. See the note above. */
  providerPdfUrl: z.string().nullable().default(null),
  createdAt: z.string().nullable().default(null),
});

export type Invoice = z.infer<typeof invoiceSchema>;

/** `{ invoices }` — the fifth envelope. */
export const invoiceListSchema = z
  .object({ invoices: z.array(invoiceSchema).default([]) })
  .transform(({ invoices }) => invoices);

/** A receipt exists only once the invoice is paid. */
export function hasReceipt(invoice: Invoice): boolean {
  return invoice.status === 'PAID' && Boolean(invoice.providerPdfUrl);
}

/**
 * Why there is no receipt link.
 *
 * `null` when there is one. Otherwise the reason, so the screen can say it
 * rather than leaving a blank cell that reads as a lost document.
 */
export function receiptAbsence(invoice: Invoice): 'not_paid' | 'missing' | null {
  if (hasReceipt(invoice)) return null;
  // A failed or draft invoice was never paid, so no receipt was ever issued.
  return invoice.status === 'PAID' ? 'missing' : 'not_paid';
}

/** Charges that did not go through. The thing a merchant most needs to see. */
export function failedInvoices(invoices: readonly Invoice[]): readonly Invoice[] {
  return invoices.filter((i) => i.status === 'FAILED');
}

/**
 * The total of a set of invoices, as a decimal string.
 *
 * Summed in minor units as integers rather than through `Number`: these are
 * money amounts arriving as decimal strings, and a float sum of `1499.00`
 * four times is the kind of error that shows up as a cent and is never
 * traced back.
 */
export function totalAmount(invoices: readonly Invoice[]): string {
  const minor = invoices.reduce((sum, invoice) => {
    const [whole = '0', frac = ''] = invoice.amount.split('.');
    const cents = Number.parseInt(`${whole}${frac.padEnd(2, '0').slice(0, 2)}`, 10);
    return sum + (Number.isFinite(cents) ? cents : 0);
  }, 0);
  return `${Math.trunc(minor / 100)}.${String(Math.abs(minor % 100)).padStart(2, '0')}`;
}
