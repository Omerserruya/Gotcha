import { describe, expect, it } from 'vitest';

import {
  failedInvoices,
  hasReceipt,
  invoiceListSchema,
  invoiceSchema,
  receiptAbsence,
  receiptHref,
  totalAmount,
  type Invoice,
} from './invoices';

const invoice = (over: Partial<Invoice> = {}): Invoice =>
  invoiceSchema.parse({
    id: 'i1',
    type: 'SUBSCRIPTION',
    status: 'FAILED',
    amount: '1499.00',
    currency: 'USD',
    ...over,
  });

describe('the fifth envelope', () => {
  it('unwraps { invoices }', () => {
    // Not { data }, not { data, nextCursor }, not a bare array, not bare
    // { subscription }. Five shapes on one platform.
    expect(invoiceListSchema.parse({ invoices: [{ id: 'i1' }] })).toHaveLength(1);
  });
});

describe('a failed invoice has no receipt, and that is consistency', () => {
  it('gives a receipt only when paid', () => {
    expect(hasReceipt(invoice({ status: 'PAID', providerPdfUrl: 'https://x/r.pdf' }))).toBe(true);
    expect(hasReceipt(invoice({ status: 'FAILED', providerPdfUrl: null }))).toBe(false);
  });

  it('explains a missing receipt as "never paid" rather than "lost"', () => {
    /*
     * `providerPdfUrl` is written in the same update that sets PAID.
     * Measured across every invoice on this machine: PAID 5 / with a PDF 5,
     * DRAFT 6 / 0, FAILED 14 / 0. The correlation is exact.
     *
     * So a blank where a link would be is the system being consistent — and
     * a blank cell reads as a document that went astray.
     */
    expect(receiptAbsence(invoice({ status: 'FAILED' }))).toBe('not_paid');
    expect(receiptAbsence(invoice({ status: 'DRAFT' }))).toBe('not_paid');
  });

  it('distinguishes a PAID invoice that really is missing its receipt', () => {
    // Different fact, different sentence: this one IS an anomaly.
    expect(receiptAbsence(invoice({ status: 'PAID', providerPdfUrl: null }))).toBe('missing');
  });

  it('says nothing when the receipt is there', () => {
    expect(receiptAbsence(invoice({ status: 'PAID', providerPdfUrl: 'https://x' }))).toBeNull();
  });

  /*
   * ══════════════════════════════════════════════════════════════════════════
   * ⚠⚠ THE THIRD REASON: A RECEIPT ARRIVED AND WE WOULD NOT OPEN IT
   * ══════════════════════════════════════════════════════════════════════════
   * `providerPdfUrl` is `z.string()` — "a string the payment provider sent",
   * not "a URL". It went into `href` unchecked, with the guard written for
   * exactly that sitting unused in `lib/safe-url.ts`.
   */
  it('⚠⚠ refuses a receipt URL that is not a URL we will navigate to', () => {
    for (const hostile of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
    ]) {
      expect(receiptHref(invoice({ status: 'PAID', providerPdfUrl: hostile })), hostile).toBeNull();
      expect(hasReceipt(invoice({ status: 'PAID', providerPdfUrl: hostile })), hostile).toBe(false);
    }
  });

  it('★★ and says so as its own reason, not as "the provider was slow"', () => {
    /*
     * `missing` reads as something that will fix itself, blames the provider,
     * and is FALSE here — a receipt did arrive. Three states, never two: the
     * one that needs somebody to look must not render as the one that does
     * not.
     */
    expect(receiptAbsence(invoice({ status: 'PAID', providerPdfUrl: 'javascript:alert(1)' }))).toBe(
      'unusable',
    );
    // Both directions, or `unusable` could quietly become the answer for every
    // unpaid invoice too.
    expect(receiptAbsence(invoice({ status: 'PAID', providerPdfUrl: null }))).toBe('missing');
    expect(receiptAbsence(invoice({ status: 'FAILED', providerPdfUrl: null }))).toBe('not_paid');
  });

  it('★ passes a real receipt through unchanged', () => {
    // A guard that rejected everything satisfies every assertion above.
    expect(
      receiptHref(invoice({ status: 'PAID', providerPdfUrl: 'https://pay.example/r.pdf' })),
    ).toBe('https://pay.example/r.pdf');
  });
});

describe('what a merchant most needs to see', () => {
  it('picks out the charges that did not go through', () => {
    const all = [
      invoice({ id: 'a', status: 'PAID' }),
      invoice({ id: 'b', status: 'FAILED' }),
      invoice({ id: 'c', status: 'FAILED' }),
    ];
    expect(failedInvoices(all).map((i) => i.id)).toEqual(['b', 'c']);
  });

  it('totals money without going through a float', () => {
    /*
     * Four subscription charges at 1499.00. Summed through Number these
     * produce the kind of error that shows up as a cent and is never traced
     * back — on the one screen where a cent is the whole subject.
     */
    const four = Array.from({ length: 4 }, (_, i) => invoice({ id: `i${i}`, amount: '1499.00' }));
    expect(totalAmount(four)).toBe('5996.00');
  });

  it('totals amounts that carry odd decimals exactly', () => {
    expect(totalAmount([invoice({ amount: '0.10' }), invoice({ amount: '0.20' })])).toBe('0.30');
  });

  it('is zero for nothing rather than NaN', () => {
    expect(totalAmount([])).toBe('0.00');
  });
});
