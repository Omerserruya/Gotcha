import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { invoiceSchema, type Invoice } from '@/api/contracts/invoices';
import messages from '@/i18n/messages/en/billing.json';

import { Invoices } from './BillingSections';

/**
 * The invoice list, which had no test, and whose receipt link was unguarded.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE GUARD EXISTED. NOTHING CALLED IT.
 * ════════════════════════════════════════════════════════════════════════════
 * `lib/safe-url.ts` was written for exactly this sink — "placing an unvalidated
 * URL in `href` or `src` is how `javascript:` payloads become script
 * execution" — and a sweep for guard-shaped exports with no non-test caller
 * found `safeLinkUrl` and `safeMediaUrl` with **zero**. Meanwhile this row
 * rendered `href={invoice.providerPdfUrl ?? '#'}`: a string the payment
 * provider wrote, straight into an anchor.
 *
 * A guard nobody calls is worse than no guard, because the file's existence is
 * the reassurance.
 *
 * ── AND THE CONTRACT TESTS ARE NOT ENOUGH ON THEIR OWN ──
 * `receiptHref` is tested in `invoices.test.ts` and was already right in
 * principle. **The defect was never in a predicate — it was that the screen did
 * not use one.** Only a test that renders the screen can see that, which is why
 * this file exists rather than three more assertions next to the others.
 */

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'billing') =>
    createTranslator({ locale: 'en', messages: { billing: messages }, namespace }),
  getLocale: async () => 'en',
}));

const invoice = (over: Partial<Invoice> = {}): Invoice =>
  invoiceSchema.parse({
    id: 'i1',
    type: 'SUBSCRIPTION',
    status: 'PAID',
    amount: '1499.00',
    currency: 'USD',
    issuedAt: '2026-09-01T00:00:00.000Z',
    ...over,
  });

const show = async (...invoices: Invoice[]) => {
  render(await Invoices({ invoices }));
};

describe('⚠⚠ the receipt link is the validated one, not the provider’s string', () => {
  it('⚠⚠ renders no anchor for a scheme that would execute instead of navigate', async () => {
    await show(invoice({ id: 'x', providerPdfUrl: 'javascript:alert(1)' }));
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('★★ and says which of the three reasons it is', async () => {
    /*
     * Not "the receipt hasn't arrived from the payment provider" — one DID
     * arrive, that sentence blames the wrong party, and it reads as something
     * that will resolve itself, so nobody ever looks. Three states, never two.
     */
    await show(invoice({ id: 'x', providerPdfUrl: 'javascript:alert(1)' }));
    expect(screen.getByTestId('no-receipt-x')).toHaveTextContent(/a receipt arrived/i);
    expect(screen.getByTestId('no-receipt-x')).not.toHaveTextContent(/hasn't arrived/i);
  });

  it('★ still links a real receipt, or this guard is just a broken feature', async () => {
    // Both directions. Refusing everything satisfies every assertion above.
    await show(invoice({ id: 'x', providerPdfUrl: 'https://pay.example/r.pdf' }));
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://pay.example/r.pdf');
  });

  it('★★ never offers a receipt for a charge that did not go through', async () => {
    /*
     * The PAID rule and the safety rule are separate, and the render tests
     * BOTH. Testing only the URL would put a receipt link on a FAILED invoice
     * that happened to carry one — contractually possible, and the last row to
     * hand somebody a receipt for.
     */
    await show(invoice({ id: 'x', status: 'FAILED', providerPdfUrl: 'https://pay.example/r.pdf' }));
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByTestId('no-receipt-x')).toHaveTextContent(/wasn't/i);
  });

  it('★ and a paid invoice with nothing at all still reads as an anomaly', async () => {
    await show(invoice({ id: 'x', providerPdfUrl: null }));
    expect(screen.getByTestId('no-receipt-x')).toHaveTextContent(/hasn't arrived/i);
  });
});
