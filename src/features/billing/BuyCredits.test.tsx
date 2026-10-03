import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { packagesResponseSchema } from '@/api/contracts/pricing';
import messages from '@/i18n/messages/en/billing.json';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

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
      /*
       * ★★ FLAT, BECAUSE THE WIRE IS FLAT — AND THIS FIXTURE IS WHY THE DEFECT
       * SHIPPED. It claimed `price: { amount, currency }`, a nested object the
       * route does not send (`price: String(p.price)` with `currency` as its
       * sibling), so the component read it happily here and got nothing in
       * production: no price on any pack, no currency symbol on any total.
       *
       * A fixture is a claim that the platform can produce this object. This
       * one could not have come from anywhere.
       *
       * ★ AND THE WIRE MOVED AGAIN (2026-10-03): the route now sends `price`
       * as a DisplayPrice object. The contract reads both; this flat one is
       * the older shape, and `WIRE` below is today's.
       */
      price: '100.00',
      currency: 'ILS',
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
      packages: [{ key: 'k', name: 'Pack', credits: 100, price: '50.00', currency: 'ILS' }],
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
          price: '50.00',
          currency: 'ILS',
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

  it('★★ `failed` must NOT say nothing was charged, because we do not know', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════
     * THE DEFECT THIS ASSERTION GUARDS, AND IT SURVIVED EVERY OTHER TEST.
     * ════════════════════════════════════════════════════════════════════
     * `t('buy.declined')` was the fallback of the ternary that chose this
     * sentence, so `failed` inherited *"The payment didn't go through, and
     * nothing was charged. You can try again."*
     *
     * `failed` is a network drop, a 500, or a response that failed its
     * contract — **and a contract failure can follow a 200 in which the card
     * was charged and the credits granted.** Telling that customer nothing
     * was charged, and inviting a retry, is the same harm the `unsettled`
     * branch two tests above exists to prevent, arriving through the parse
     * instead of through the provider.
     *
     * Mutating the sentence back turns this red and nothing else.
     */
    buyCreditPack.mockResolvedValue({ ok: false, kind: 'failed' });
    const user = userEvent.setup();
    show();
    await user.click(screen.getByTestId('buy-button'));

    const error = await screen.findByTestId('buy-error');
    expect(error).not.toHaveTextContent(/nothing was charged/i);
    expect(error).toHaveTextContent(/can.t tell you whether your card was charged/i);
    // And it sends them to look before pressing anything again.
    expect(error).toHaveTextContent(/check your invoices/i);
  });

  it('★★ a cap names the cap when the platform sends one', async () => {
    // `detail: { max }` travels on the 402 and used to be stripped by the
    // error envelope, so the number was always null and never said.
    buyCreditPack.mockResolvedValue({ ok: false, kind: 'too_many', max: 10 });
    const user = userEvent.setup();
    show();
    await user.click(screen.getByTestId('buy-button'));

    const error = await screen.findByTestId('buy-error');
    expect(error).toHaveTextContent(/at most 10/i);
    expect(error).toHaveTextContent(/nothing was charged/i);
  });

  it('★ a pack that is not for sale says a retry will not help', async () => {
    buyCreditPack.mockResolvedValue({ ok: false, kind: 'not_purchasable' });
    const user = userEvent.setup();
    show();
    await user.click(screen.getByTestId('buy-button'));

    const error = await screen.findByTestId('buy-error');
    expect(error).toHaveTextContent(/isn.t available on your plan|no longer sold/i);
    expect(error).toHaveTextContent(/won.t change it/i);
  });
});

describe('★★ one purchase, one intent key — and when it is released', () => {
  /*
   * ════════════════════════════════════════════════════════════════════════
   * THE TWO FAILURES ARE NOT SYMMETRIC, AND THAT DECIDES EVERY CASE HERE.
   * ════════════════════════════════════════════════════════════════════════
   * Reusing the key too long: a customer who wants two packs presses twice
   * and gets one. Visible, and they can press again once the first settles.
   *
   * Minting it too eagerly: a retry after a charge whose outcome is unknown
   * is charged twice. Invisible until the statement, and not recoverable by
   * pressing anything.
   *
   * So the key is held while the outcome is unknown and released only when
   * the attempt is finished.
   */

  it('★★ a retry after an UNSETTLED charge carries the same key', async () => {
    /*
     * THE CASE THE KEY EXISTS FOR. The outcome is unknown and the card may
     * already have been charged; the same key is what makes the server treat
     * a second press as the same purchase rather than a second one.
     */
    buyCreditPack.mockResolvedValue({ ok: false, kind: 'unsettled', invoiceId: 'inv_7' });
    const user = userEvent.setup();
    show();
    await user.click(screen.getByTestId('buy-button'));
    await user.click(screen.getByTestId('buy-button'));

    expect(buyCreditPack).toHaveBeenCalledTimes(2);
    expect(buyCreditPack.mock.calls[0]![2]).toBe(buyCreditPack.mock.calls[1]![2]);
  });

  it('★★ a retry after an UNKNOWN failure carries the same key too', async () => {
    // `failed` includes a contract failure, which can follow a 200 in which
    // the card WAS charged. Same reasoning, arriving by a different route.
    buyCreditPack.mockResolvedValue({ ok: false, kind: 'failed' });
    const user = userEvent.setup();
    show();
    await user.click(screen.getByTestId('buy-button'));
    await user.click(screen.getByTestId('buy-button'));

    expect(buyCreditPack.mock.calls[0]![2]).toBe(buyCreditPack.mock.calls[1]![2]);
  });

  it('★★ a press after a SETTLED success is a new purchase and gets a new key', async () => {
    // The first purchase is finished. Reusing the key here would make the
    // server collapse a genuine second pack into the first one.
    buyCreditPack.mockResolvedValue({ ok: true, units: 1000, invoiceId: 'inv_1' });
    const user = userEvent.setup();
    show();
    await user.click(screen.getByTestId('buy-button'));
    await user.click(screen.getByTestId('buy-button'));

    expect(buyCreditPack.mock.calls[0]![2]).not.toBe(buyCreditPack.mock.calls[1]![2]);
  });

  it('★★ a press after a DECLINE gets a new key, because the refusal is cached', async () => {
    /*
     * An idempotency key caches the provider's answer, including a refusal.
     * Somebody who fixes their card and presses again must not be handed the
     * decline that was recorded against the old key.
     */
    buyCreditPack.mockResolvedValue({ ok: false, kind: 'declined', code: 'card_declined' });
    const user = userEvent.setup();
    show();
    await user.click(screen.getByTestId('buy-button'));
    await user.click(screen.getByTestId('buy-button'));

    expect(buyCreditPack.mock.calls[0]![2]).not.toBe(buyCreditPack.mock.calls[1]![2]);
  });

  it('sends a DIFFERENT key when the quantity changes', async () => {
    // A change of intent, which is the customer saying this is a different
    // purchase. Held while unsettled, so the outcome here is the one that
    // would otherwise keep the key.
    buyCreditPack.mockResolvedValue({ ok: false, kind: 'unsettled', invoiceId: null });
    const user = userEvent.setup();
    show();
    await user.click(screen.getByTestId('buy-button'));
    const qty = screen.getByTestId('buy-quantity');
    await user.clear(qty);
    await user.type(qty, '2');
    await user.click(screen.getByTestId('buy-button'));

    expect(buyCreditPack.mock.calls[0]![2]).not.toBe(buyCreditPack.mock.calls[1]![2]);
  });

  it('★ the key is not a clock: two presses in one attempt are one purchase', async () => {
    /*
     * The key used to carry `Math.floor(Date.now() / 60_000)`. Two deliberate
     * presses either side of a minute boundary were two purchases and two
     * presses within one minute were one — and neither edge is where the
     * customer's intent changed. Nothing about time appears in it now.
     */
    buyCreditPack.mockResolvedValue({ ok: false, kind: 'unsettled', invoiceId: null });
    const user = userEvent.setup();
    show();
    await user.click(screen.getByTestId('buy-button'));

    const key = buyCreditPack.mock.calls[0]![2] as string;
    expect(key).toMatch(/^buy:/);
    /*
     * ★★ THE SPECIFIC VALUE THE OLD CODE EMBEDDED, NOT A SHAPE.
     *
     * This asserted `not.toMatch(/\d{8,}/)` — "no long number" — and a v4
     * UUID contains a run of eight digits **8% of the time**, measured over
     * 20,000 samples. So the test failed about one run in twelve with nothing
     * wrong, which is almost certainly the single unexplained failure reported
     * after a bulk reformat earlier today and never identified.
     *
     * A flaky assertion is worse than no assertion: it teaches everybody that
     * a red run might be noise. What it MEANT was that the key carries no
     * clock, so it now looks for the exact minute bucket the previous
     * implementation embedded — a value that cannot appear by chance.
     */
    expect(key).not.toContain(String(Math.floor(Date.now() / 60_000)));
  });
});

describe('★★ the tax label is in the reader’s language, not the tenant’s', () => {
  it('★★ never shows the platform’s own label, which arrives as Hebrew', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * A BROWSER WALK FOUND `מע"מ` IN THE MONEY SUMMARY OF THE ENGLISH SCREEN
     * ════════════════════════════════════════════════════════════════════════
     * `taxed.label` is the platform's, localised to the ACCOUNT — correct for
     * an Israeli tenant and wrong for a reader who chose English. It was
     * preferred over our own translation, so the label came through in Hebrew.
     *
     * The rate still has to be there: dropping the platform's string must not
     * drop what it was telling somebody.
     */
    /*
     * Built through `packagesResponseSchema`, like `PACKS`. A first version
     * hand-rolled the object and the component threw on a missing
     * `expiryPolicy` — a fixture is a claim that the platform can produce it,
     * and that one could not have come from anywhere.
     */
    const hebrewLabel = packagesResponseSchema.parse({
      eligible: true,
      tax: { ratePct: 18, label: 'מע"מ' },
      packages: [
        {
          key: 'pack_1k',
          name: 'Starter',
          credits: 1000,
          /*
           * ★★ FLAT, BECAUSE THE WIRE IS FLAT — AND THIS FIXTURE IS WHY THE DEFECT
           * SHIPPED. It claimed `price: { amount, currency }`, a nested object the
           * route does not send (`price: String(p.price)` with `currency` as its
           * sibling), so the component read it happily here and got nothing in
           * production: no price on any pack, no currency symbol on any total.
           *
           * A fixture is a claim that the platform can produce this object. This
           * one could not have come from anywhere.
           */
          price: '100.00',
          currency: 'ILS',
          expiryPolicy: 'NEVER',
          taxed: { net: '100.00', tax: '18.00', gross: '118.00', percent: 18, label: 'מע"מ' },
          maxPurchaseQuantity: 3,
        },
      ],
    });
    show({ packages: hebrewLabel });

    const label = await screen.findByTestId('buy-tax-label');
    expect(label).toHaveTextContent(/VAT/i);
    expect(label).toHaveTextContent(/18/);
    // The Hebrew block — nothing in it should reach an English screen here.
    expect(label.textContent ?? '').not.toMatch(/[֐-׿]/);
  });
});

describe('★★ the four defects a browser walk found in one panel', () => {
  it('★★ a pack shows its price, which no pack had', async () => {
    /*
     * The contract read `price: { amount, currency }` — a nested object the
     * route does not send. `price` is a string and `currency` is its sibling,
     * so the object schema failed, the default fired, and every tile was
     * priceless while every total lost its symbol. One cause, two reports.
     */
    show();
    expect(await screen.findByTestId('buy-pack-price-pack_1k')).toHaveTextContent(/100/);
  });

  it('★★ and the totals carry the currency again', async () => {
    show();
    /* ILS renders as ₪ or as "ILS" depending on the runtime's data; either is
       a currency, and a bare number is not. */
    const net = await screen.findByTestId('buy-net');
    expect(net.textContent ?? '').toMatch(/[₪]|ILS/);
  });

  it('★★ the credit count is not printed twice', async () => {
    /*
     * The packs are named for their size on this tenant, so the tile read
     * "1,000 credits · 1,000 credits · These credits do not expire". The name
     * is the tenant's and the count is ours; where they say the same thing,
     * ours goes.
     */
    show({
      packages: packagesResponseSchema.parse({
        eligible: true,
        tax: { ratePct: 18, label: 'VAT 18%' },
        packages: [
          {
            key: 'pack_1k',
            name: '1,000 credits',
            credits: 1000,
            price: '100.00',
            currency: 'ILS',
            expiryPolicy: 'NEVER',
            taxed: { net: '100.00', tax: '18.00', gross: '118.00', percent: 18 },
            maxPurchaseQuantity: 3,
          },
        ],
      }),
    });

    const tile = await screen.findByTestId('buy-pack-pack_1k');
    const occurrences = (tile.textContent ?? '').match(/1,000 credits/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it('★ a name that does NOT state the count keeps the count line', async () => {
    // The check is about duplication, not about hiding the number.
    show();
    const tile = await screen.findByTestId('buy-pack-pack_1k');
    expect(tile).toHaveTextContent(/1,000 credits/);
    expect(tile).toHaveTextContent(/Starter/);
  });

  it('★★ the buy control is a button, not centred plain text', async () => {
    /*
     * It was a raw `<button className={styles.buyButton}>` and the stylesheet
     * had ONLY a `.buyButton:disabled` rule — no base style. On the screen that
     * charges a card, the thing you press did not look like one.
     */
    show();
    const button = await screen.findByTestId('buy-button');
    expect(button.tagName).toBe('BUTTON');
    /* The primitive's class, which carries both states. */
    expect(button.className).not.toBe('');
  });
});

/** Today's wire: four packs priced as DisplayPrice, all never expiring. */
const WIRE = packagesResponseSchema.parse({
  eligible: true,
  packages: [
    ['credits_1000', 1000, '25.00'],
    ['credits_5000', 5000, '110.00'],
    ['credits_20000', 20000, '399.00'],
    ['credits_50000', 50000, '899.00'],
  ].map(([key, credits, amount]) => ({
    key,
    name: `${Number(credits).toLocaleString('en')} credits`,
    credits,
    price: {
      base: { amount, currency: 'USD', formatted: `$${amount}` },
      display: { amount, currency: 'USD', formatted: `$${amount}` },
      isEstimatedConversion: false,
      chargedCurrency: 'USD',
      fx: null,
    },
    taxed: {
      net: amount,
      tax: (Number(amount) * 0.18).toFixed(2),
      gross: (Number(amount) * 1.18).toFixed(2),
      percent: 18,
    },
    expiryPolicy: 'NEVER',
  })),
});

const showWire = (extra: Record<string, unknown> = {}) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ billing: messages }}>
      <BuyCredits packages={WIRE} billable hasPaymentMethod {...extra} />
    </NextIntlClientProvider>,
  );

describe('★ 17d — 02’s dialog (measurement of 208d849)', () => {
  it('no second "Buy credits" heading inside the dialog', () => {
    showWire();
    expect(screen.queryByRole('heading', { name: /buy credits/i })).toBeNull();
  });

  it('a tile is credits, price and price per credit; the shared expiry is said once', () => {
    showWire();
    expect(screen.getByTestId('buy-pack-each-credits_1000')).toHaveTextContent('$0.025 each');
    expect(
      screen
        .getAllByText('These credits do not expire.')
        .filter((el) => !el.classList.contains('srOnly')),
    ).toHaveLength(1);
    expect(screen.getByTestId('buy-expiry-shared')).toBeInTheDocument();
  });

  it('one button, the money in its label', () => {
    showWire();
    expect(screen.getByTestId('buy-button')).toHaveTextContent('Pay $25.00 · incl. VAT $29.50');
  });

  it('"Pay with" the card, and the receipt address beside the button', () => {
    showWire({ card: { brand: 'Visa', last4: '4417' }, receiptTo: 'finance@example.com' });
    expect(screen.getByTestId('buy-pay-with')).toHaveTextContent('Pay withVisa · 4417');
    expect(screen.getByTestId('buy-receipt')).toHaveTextContent('Receipt to finance@example.com');
  });

  it('no card: "No card on file" in the same row', () => {
    showWire({ hasPaymentMethod: false });
    expect(screen.getByTestId('buy-pay-with')).toHaveTextContent('No card on file');
  });
});
