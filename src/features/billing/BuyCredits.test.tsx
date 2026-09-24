import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { packagesResponseSchema } from '@/api/contracts/pricing';
import messages from '@/i18n/messages/en/billing.json';

import { BuyCredits } from './BuyCredits';

/**
 * Screen 17d — buying credits.
 *
 * ── NOTHING HERE CALLS THE REAL ACTION ──
 * `POST /billing/credits/buy` charges a live card on a real tenant. The
 * action is mocked, and on the deployment these screens are photographed
 * against the button is disabled anyway: `buyCredits()` checks
 * `no_billable_entity` first and this workspace has no billing profile.
 *
 * Which means the interesting half of this screen — the totals, the three
 * outcomes, the cap — is unreachable by any capture and lives only here.
 */

const buyCreditPack = vi.hoisted(() => vi.fn());
vi.mock('./actions', () => ({ buyCreditPack }));

beforeEach(() => {
  buyCreditPack.mockReset();
  buyCreditPack.mockResolvedValue({ ok: true, units: 1000, invoiceId: 'inv_1' });
});

const PACKS = packagesResponseSchema.parse({
  eligible: true,
  tax: { ratePct: 18, label: 'VAT 18%' },
  packages: [
    {
      key: 'pack_1k',
      name: 'Starter',
      credits: 1000,
      price: { amount: 100, currency: 'ILS' },
      expiryPolicy: 'NEVER',
      taxed: { net: '100.00', tax: '18.00', gross: '118.00', percent: 18, label: 'VAT 18%' },
      maxPurchaseQuantity: 3,
    },
  ],
});

function show(over: { billable?: boolean; hasPaymentMethod?: boolean; packages?: unknown } = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ billing: messages }}>
      <BuyCredits
        packages={(over.packages === undefined ? PACKS : over.packages) as typeof PACKS}
        billable={over.billable ?? true}
        hasPaymentMethod={over.hasPaymentMethod ?? true}
      />
    </NextIntlClientProvider>,
  );
}

describe('★ the price on the tile is not the price that is charged', () => {
  it('shows net, VAT and a total — and the total is the gross', () => {
    /*
     * Catalogue prices are NET. `taxed` has been on the wire all along and
     * our `z.object` contract was stripping it, so this screen could only
     * ever have shown ₪100 for a purchase that takes ₪118.
     *
     * That is the worst failure a buy screen has, and it fails in the
     * reassuring direction: nobody complains about a number that looks too
     * small until the statement arrives.
     */
    show();
    expect(screen.getByTestId('buy-net')).toHaveTextContent(/100/);
    expect(screen.getByTestId('buy-tax')).toHaveTextContent(/18/);
    const total = screen.getByTestId('buy-total');
    expect(total).toHaveTextContent(/118/);
    // Explicitly NOT the net figure, which is the number a design would show.
    expect(total).not.toHaveTextContent(/^\D*100\D*$/);
  });

  it('multiplies by quantity without re-deriving the tax', async () => {
    // From `taxed`, never from price × rate: the server rounds each component
    // to its own scale, and a UI that rounds again differs from the invoice
    // by a penny nobody can account for afterwards.
    const user = userEvent.setup();
    show();
    await user.clear(screen.getByTestId('buy-quantity'));
    await user.type(screen.getByTestId('buy-quantity'), '2');
    expect(screen.getByTestId('buy-total')).toHaveTextContent(/236/);
  });

  it('★ refuses to state a total when there is no tax block', () => {
    /*
     * Not zero tax. `taxSummaryForTenant` REFUSES rather than defaulting when
     * a profile has declared no country, because "defaulting to 0% would
     * charge an Israeli customer no VAT". So an absent block means we were
     * not told, and an unknown total is not a total.
     */
    const untaxed = packagesResponseSchema.parse({
      eligible: true,
      packages: [{ key: 'k', name: 'Pack', credits: 100, price: { amount: 50, currency: 'ILS' } }],
    });
    show({ packages: untaxed });
    expect(screen.getByTestId('buy-total-unknown')).toHaveTextContent(/can.t show a total/i);
    expect(screen.queryByTestId('buy-total')).toBeNull();
    // And with no total there is nothing to agree to.
    expect(screen.getByTestId('buy-button')).toBeDisabled();
  });

  it('says “not liable” rather than “VAT 0%” for an exempt business', () => {
    // `exempt` is a status; 0% is an amount. Only one of them is true of a
    // business that is exempt, and they are not interchangeable on an invoice.
    const exempt = packagesResponseSchema.parse({
      eligible: true,
      packages: [
        {
          key: 'k',
          name: 'Pack',
          credits: 100,
          price: { amount: 50, currency: 'ILS' },
          taxed: { net: '50.00', tax: '0.00', gross: '50.00', percent: 0, exempt: true },
        },
      ],
    });
    show({ packages: exempt });
    expect(screen.getByTestId('buy-tax-label')).toHaveTextContent(/not liable for VAT/i);
    expect(screen.getByTestId('buy-tax-label')).not.toHaveTextContent(/0%/);
  });
});

describe('★ per-pack expiry, from the packages response and never the summary', () => {
  it('states when each pack’s credits die', () => {
    /*
     * `/billing/credit-summary` selects `expiresAt` from the lots and keeps
     * only `grantType`, so AFTER the purchase nothing can tell a customer
     * when these credits expire. Before it, this is the only place.
     */
    show();
    /*
     * ASSERTED BY ITS WORDS, not by being non-empty.
     *
     * The first version of this test asserted `/\S/` and passed while the
     * key was wrong, because next-intl's dev fallback renders the key path.
     * The capture build returns '' for a missing key, so the line would have
     * been blank in every shot with the suite green — 11d again.
     */
    expect(screen.getByTestId('buy-pack-expiry-pack_1k')).toHaveTextContent(
      /these credits do not expire/i,
    );
    // And never the key path, which is what a missing message renders in dev.
    expect(screen.getByTestId('buy-pack-expiry-pack_1k')).not.toHaveTextContent(
      /packages\.expiry/i,
    );
  });
});

describe('★ the button does not pretend it can work', () => {
  it('disables with the NO-ACCOUNT reason, which is not the no-card one', () => {
    // `buyCredits()` checks `no_billable_entity` first. "Nobody to invoice"
    // and "nothing to charge" are different problems with different repairs.
    show({ billable: false, hasPaymentMethod: false });
    expect(screen.getByTestId('buy-button')).toBeDisabled();
    const blocked = screen.getByTestId('buy-blocked');
    expect(blocked).toHaveTextContent(/nobody to invoice/i);
    expect(blocked).not.toHaveTextContent(/payment method/i);
  });

  it('disables with the NO-CARD reason when there is somebody to invoice', () => {
    show({ billable: true, hasPaymentMethod: false });
    const blocked = screen.getByTestId('buy-blocked');
    expect(blocked).toHaveTextContent(/no payment method/i);
    expect(blocked).not.toHaveTextContent(/nobody to invoice/i);
  });

  it('caps the quantity at the server’s own maximum', async () => {
    // The route enforces `quantity_exceeds_maximum`. A control that let
    // somebody pick 9 when the cap is 3 is a purchase the server refuses.
    const user = userEvent.setup();
    show();
    const qty = screen.getByTestId('buy-quantity') as HTMLInputElement;
    await user.clear(qty);
    await user.type(qty, '9');

    /*
     * The TOTAL is clamped immediately — it is derived from the capped
     * quantity, so neither the amount shown nor the amount sent can exceed
     * the cap even if a click lands before the field is blurred.
     */
    expect(screen.getByTestId('buy-total')).toHaveTextContent(/354/);

    // And the box itself is normalised once they leave it, so the number on
    // screen agrees with the number being charged for.
    await user.tab();
    expect(Number(qty.value)).toBeLessThanOrEqual(3);
  });
});

describe('★★ an unsettled charge is not a failure', () => {
  it('does not say “failed”, and does not invite a retry', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════
     * THE MOST CONSEQUENTIAL BRANCH ON THIS SCREEN.
     * ════════════════════════════════════════════════════════════════════
     * The route answers 409 rather than 402 deliberately, and says why: "a
     * payment-required response invites the customer to try again, and they
     * may already have been charged."
     *
     * Flattening three outcomes into "Something went wrong, try again" —
     * which is exactly what a redesign does to error states — takes money
     * from somebody twice. So this must say a charge MAY have been made,
     * must not say failed, and must tell them not to retry.
     */
    buyCreditPack.mockResolvedValue({ ok: false, kind: 'unsettled', invoiceId: null });
    const user = userEvent.setup();
    show();
    await user.click(screen.getByTestId('buy-button'));

    const note = await screen.findByTestId('buy-unsettled');
    expect(note).toHaveTextContent(/don.t yet know whether that payment went through/i);
    expect(note).toHaveTextContent(/do NOT try again/i);
    expect(note).toHaveTextContent(/may already have been charged/i);
    // The words that would undo all of it.
    expect(note).not.toHaveTextContent(/failed/i);
    expect(note).not.toHaveTextContent(/didn.t go through/i);
    // And it is NOT rendered as a plain error.
    expect(screen.queryByTestId('buy-error')).toBeNull();
  });

  it('a settled decline DOES say nothing was charged, and may be retried', async () => {
    // The other side of the same coin: a merchant whose card was declined
    // needs to know they can try, and that they were not charged.
    buyCreditPack.mockResolvedValue({ ok: false, kind: 'declined', code: 'card_declined' });
    const user = userEvent.setup();
    show();
    await user.click(screen.getByTestId('buy-button'));

    const error = await screen.findByTestId('buy-error');
    expect(error).toHaveTextContent(/nothing was charged/i);
    expect(error).toHaveTextContent(/try again/i);
  });
});

describe('★ one purchase, one intent key', () => {
  it('sends the SAME key when the same choice is bought twice', async () => {
    /*
     * The server turns a double-click into one charge by this key. Minted
     * per click it would be a new purchase each time — identical code,
     * identical appearance, protection silently gone.
     */
    const user = userEvent.setup();
    show();
    await user.click(screen.getByTestId('buy-button'));
    await user.click(screen.getByTestId('buy-button'));

    expect(buyCreditPack).toHaveBeenCalledTimes(2);
    const first = buyCreditPack.mock.calls[0]![2];
    const second = buyCreditPack.mock.calls[1]![2];
    expect(first).toBe(second);
  });

  it('sends a DIFFERENT key when the quantity changes', async () => {
    // Because that genuinely is a different purchase, and reusing the key
    // would make the server collapse it into the first one.
    const user = userEvent.setup();
    show();
    await user.click(screen.getByTestId('buy-button'));
    const qty = screen.getByTestId('buy-quantity');
    await user.clear(qty);
    await user.type(qty, '2');
    await user.click(screen.getByTestId('buy-button'));

    expect(buyCreditPack.mock.calls[0]![2]).not.toBe(buyCreditPack.mock.calls[1]![2]);
  });
});
