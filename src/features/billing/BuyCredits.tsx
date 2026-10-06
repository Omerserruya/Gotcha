'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useRef, useState, useTransition } from 'react';

import {
  chargeable,
  maxQuantity,
  type CreditPackage,
  type PackagesResponse,
} from '@/api/contracts/pricing';

import { packagePrice } from '@/api/contracts/pricing';
import { Button } from '@/design-system/primitives/button/Button';

import { buyCreditPack, type BuyOutcome } from './actions';
import { Link } from '@/i18n/navigation';

import styles from './Billing.module.css';

/**
 * Screen 17d — buying credits.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★ THE PRICE ON THE TILE IS NOT THE PRICE THAT IS CHARGED
 * ════════════════════════════════════════════════════════════════════════════
 * Catalogue prices are NET. `taxed` has been on the wire all along — the
 * route carries it so "the confirm dialog can state the amount that will
 * actually be charged rather than the one on the tile" — and our contract,
 * being `object` rather than `looseObject`, was stripping it at the boundary.
 * Screen 17 could only ever have shown the net figure.
 *
 * So this shows net, tax and total, and the TOTAL is the prominent one.
 * Showing ₪100 and charging ₪118 is the worst thing a buy screen can do, and
 * it fails in the reassuring direction.
 *
 * The total comes from `taxed`, never from price × rate: the server rounds
 * each component to its own scale, and a UI that multiplies and rounds again
 * differs from the invoice by a penny nobody can account for afterwards.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★ AND THE BUTTON DOES NOT WORK ON THIS TENANT, SO IT SAYS SO
 * ════════════════════════════════════════════════════════════════════════════
 * `buyCredits()` checks `no_billable_entity` FIRST. This workspace has no
 * billing profile and no payment method — the two facts screen 17e renders —
 * so every purchase would fail before it reached a card.
 *
 * A live button here would fail on every click and read as the page being
 * broken. The 14d ruling applies unchanged: show the real thing, disable the
 * action, give the reason, point at the repair. The packs, their credits,
 * their expiry and their VAT are all REAL and all readable without a card.
 *
 * ── WHY `intentKey` IS MINTED WITH THE CHOICE AND NOT WITH THE CLICK ──
 * The server turns a double-click into ONE charge by that key. Generated per
 * click it would be a new purchase each time — identical code, identical
 * appearance, and the protection silently gone.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ AND WHY IT IS A REF AND NOT A `useMemo`
 * ════════════════════════════════════════════════════════════════════════════
 * **React may discard a memo whenever it likes** — that is documented, not a
 * bug — and this key used to be `useMemo(() => …Date.now()…)`. A discard at a
 * minute boundary minted a new key for a purchase already in flight, so the
 * double-charge guard rested on a cache React is free to throw away. Nothing
 * would have shown it: identical code, identical appearance, and the second
 * charge only visible on a statement.
 *
 * The rule, which is about money rather than about React:
 *
 *   REUSE while the outcome is PENDING or UNKNOWN. A retry after `unsettled`
 *   must carry the same key. That is the entire reason the key exists, and it
 *   is the case where a fresh one charges a card twice for one intent.
 *
 *   MINT on a SETTLED outcome — a confirmed success, or a confirmed failure in
 *   which nothing was charged. The attempt is finished and the next press is a
 *   new purchase. It matters on a decline too: an idempotency key caches the
 *   provider's answer, so reusing it after a card was refused can hand back
 *   the cached refusal to somebody who has since fixed their card.
 *
 *   MINT on a change of intent — a different pack, a different quantity, or
 *   leaving and coming back. The customer is saying this is a different
 *   purchase.
 *
 *   NEVER mint on a timer, a re-render or a memo discard inside one pending
 *   purchase.
 *
 * The two failures are not symmetric, which is what decides every unclear
 * case. Reusing too long means a customer who wants two packs presses twice
 * and gets one — visible, and they can press again once the first settles.
 * Minting too eagerly means a retry after an unsettled charge is charged
 * twice — invisible until the statement, and unrecoverable by pressing
 * anything. **Take the recoverable failure.**
 */
export function BuyCredits({
  packages,
  billable,
  hasPaymentMethod,
  card = null,
  receiptTo = null,
}: {
  readonly packages: PackagesResponse | null;
  /**
   * Is there anything to bill? `profileReading(profile) !== 'no_account'`.
   * Distinct from having a card: one is who the invoice is made out to, the
   * other is what pays it, and they fail with different repairs.
   */
  readonly billable: boolean;
  readonly hasPaymentMethod: boolean;
  /** 02's "Pay with": the card that would be charged, when one was read. */
  readonly card?: { readonly brand: string | null; readonly last4: string | null } | null;
  /** 02's "Receipt to …", beside the button. */
  readonly receiptTo?: string | null;
}) {
  const t = useTranslations('billing');
  const format = useFormatter();

  const sellable = packages?.packages ?? [];
  const [chosen, setChosen] = useState<string>(sellable[0]?.key ?? '');
  /*
   * ★ HELD AS THE RAW STRING, AND CLAMPED ON BLUR RATHER THAN ON EVERY KEY.
   *
   * The obvious version keeps a number and clamps in `onChange`. Clearing the
   * box then produces `NaN`, which snaps the controlled value back to 1 — so
   * somebody who selects the field, deletes it and types "2" ends up with
   * "12", silently clamped to the pack's maximum.
   *
   * They wanted two packs and bought three. No error, no warning, and the
   * total updates smoothly the whole way. Caught by a unit test expecting
   * ₪236 and reading ₪354.
   */
  const [quantityText, setQuantityText] = useState('1');
  const [outcome, setOutcome] = useState<BuyOutcome | null>(null);
  const [isPending, startTransition] = useTransition();

  const pkg: CreditPackage | undefined = sellable.find((p) => p.key === chosen);

  /*
   * One fact is said once. When every pack shares its expiry — all four
   * never expire on this tenant — it is one line under the tiles, not the
   * same sentence in each of them.
   */
  const expiryOf = (p: CreditPackage) =>
    p.expiryPolicy === 'DAYS_AFTER_PURCHASE'
      ? t('pricing.packages.expiry.DAYS_AFTER_PURCHASE', { days: p.expiryDays ?? 0 })
      : t(`pricing.packages.expiry.${p.expiryPolicy}`);
  const sharedExpiry =
    sellable.length > 0 && new Set(sellable.map(expiryOf)).size === 1
      ? expiryOf(sellable[0]!)
      : null;

  /*
   * One key per (package, quantity). See the note above: this is the whole
   * double-click protection, and it is invisible when it is wrong.
   */
  const parsed = Number.parseInt(quantityText, 10);
  const typed = Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
  /*
   * ★ CLAMPED HERE, NOT ONLY ON BLUR.
   *
   * Blur normalises what the box SHOWS. This is what the total is computed
   * from and what the purchase sends, so neither can ever exceed the cap the
   * route enforces — including in the case where somebody types past it and
   * the click lands before the blur.
   */
  const quantity = pkg ? Math.min(typed, maxQuantity(pkg)) : typed;

  /*
   * The purchase this key belongs to. Not a dependency array: a ref survives
   * exactly the events a memo does not, and it is replaced only by the two
   * rules above.
   */
  const intent = `${chosen}:${quantity}`;
  const intentKeyRef = useRef<{ readonly intent: string; readonly key: string } | null>(null);

  if (!packages || sellable.length === 0) return null;

  const total = pkg ? chargeable(pkg, quantity) : null;
  /*
   * ★ ONE LOOKUP. `price` and `currency` are flat siblings on the wire — see
   * `packagePrice` — and a price without a currency is not a price, so the
   * pair travels together or not at all.
   */
  const price = pkg ? packagePrice(pkg) : null;
  const blocked = !billable ? 'no_account' : !hasPaymentMethod ? 'no_card' : null;

  function buy() {
    if (!pkg || blocked) return;
    /*
     * Minted here, in an event handler, so nothing impure runs during a
     * render — and read from the ref, so a re-render between this press and
     * the next cannot change it.
     */
    if (intentKeyRef.current?.intent !== intent) {
      intentKeyRef.current = { intent, key: `buy:${intent}:${crypto.randomUUID()}` };
    }
    const intentKey = intentKeyRef.current.key;

    setOutcome(null);
    startTransition(async () => {
      const result = await buyCreditPack(pkg!.key, quantity, intentKey);
      setOutcome(result);
      /*
       * ★★ THE KEY IS RELEASED ONLY BY A SETTLED OUTCOME.
       * `unsettled` and `failed` both mean we do not know whether the card
       * was charged, so a retry has to carry the same key — which is the one
       * case the key exists for. Everything else is finished: the next press
       * is a new purchase and gets a new key.
       */
      if (isSettled(result)) intentKeyRef.current = null;
    });
  }

  return (
    <section className={styles.block} data-testid="buy-credits">
      <ul className={styles.buyPacks} data-testid="buy-packs">
        {sellable.map((p) => (
          <li key={p.key}>
            <label className={styles.buyPack} data-testid={`buy-pack-${p.key}`}>
              <input
                type="radio"
                name="credit-pack"
                value={p.key}
                checked={chosen === p.key}
                onChange={() => {
                  setChosen(p.key);
                  setQuantityText('1');
                  setOutcome(null);
                }}
              />
              <span className={styles.buyPackName}>{p.name}</span>
              {/*
                ★★ THE CREDIT COUNT ONLY WHEN THE NAME DOES NOT ALREADY SAY IT.
                The packs are named for their size on this tenant, so the tile
                read *"1,000 credits · 1,000 credits · These credits do not
                expire"*. The name is the tenant's and the count is ours; where
                they are the same fact, ours goes.
              */}
              {p.name.includes(format.number(p.credits)) ? null : (
                <span className={styles.buyPackCredits}>
                  {t('pricing.packages.credits', { credits: format.number(p.credits) })}
                </span>
              )}
              {/*
                ★★ THE PRICE, WHICH NO PACK HAD. The design prices them and the
                contract was reading a nested object the wire does not send —
                so every tile was priceless and every total was unsymbolled,
                from one mismatch.
              */}
              {packagePrice(p) ? (
                <span className={styles.buyPackPrice} data-testid={`buy-pack-price-${p.key}`}>
                  {money(format, packagePrice(p)!.amount, packagePrice(p)!.currency)}
                </span>
              ) : null}
              {/*
                ⚠ `pricing.packages.*`, NOT `packages.*`. Pricing.tsx reads
                with the namespace `billing.pricing`; this component reads
                `billing`, so the same-looking key resolves somewhere that
                does not exist.

                The first draft got it wrong and the TEST PASSED — it
                asserted `/\S/`, and next-intl's dev fallback renders the key
                path, which is not whitespace. In the production capture build
                `getMessageFallback` returns `''`, so the line would have been
                EMPTY in every shot while the suite stayed green. Screen 11d,
                exactly, caught this time by a MISSING_MESSAGE in the test log
                that nothing was asserting on.

                ★ THE ONLY PLACE PER-PACK EXPIRY EVER REACHES A CUSTOMER.
                `/billing/credit-summary` strips `expiresAt` from the lots and
                keeps only `grantType`, so AFTER the purchase nothing can tell
                them when these credits die. Before it, this can — and it is
                read per pack, never from the summary.
              */}
              {/* 02's "₪0.065 each": arithmetic on the two real numbers. */}
              {packagePrice(p) && p.credits > 0 ? (
                <span className={styles.buyPackEach} data-testid={`buy-pack-each-${p.key}`}>
                  {t('buy.each', {
                    price: format.number(packagePrice(p)!.amount / p.credits, {
                      style: 'currency',
                      currency: packagePrice(p)!.currency,
                      maximumSignificantDigits: 2,
                    }),
                  })}
                </span>
              ) : null}
              <span
                className={sharedExpiry ? 'srOnly' : styles.buyPackExpiry}
                data-testid={`buy-pack-expiry-${p.key}`}
              >
                {expiryOf(p)}
              </span>
            </label>
          </li>
        ))}
      </ul>

      {sharedExpiry ? (
        <p className={styles.buyShared} data-testid="buy-expiry-shared">
          {sharedExpiry}
        </p>
      ) : null}

      {/* 02's "Pay with": the card, or its absence in the same row. */}
      <p className={styles.buyPayWith} data-testid="buy-pay-with">
        <span className={styles.buyPayLabel}>{t('buy.payWith')}</span>
        <span className={styles.buyPayCard}>
          {card
            ? `${card.brand ?? t('profile.unknownBrand')} · ${card.last4 ?? '—'}`
            : hasPaymentMethod
              ? '—'
              : t('profile.noCardRow')}
        </span>
      </p>

      {/*
        02 draws no quantity: a pack is the amount. The field appears only
        where the server says a pack may be bought several at once.
      */}
      {pkg && (pkg.maxPurchaseQuantity ?? 0) > 1 ? (
        <label className={styles.buyQuantity}>
          <span>{t('buy.quantity')}</span>
          <input
            type="number"
            min={1}
            max={maxQuantity(pkg)}
            value={quantityText}
            data-testid="buy-quantity"
            onChange={(event) => {
              // Typed freely, including empty. See the note on `quantityText`.
              setQuantityText(event.target.value);
              setOutcome(null);
            }}
            onBlur={() => {
              /*
                Clamped once they have finished, to the SERVER's own cap —
                the route enforces `quantity_exceeds_maximum`. Doing it here
                rather than per keystroke is what lets somebody retype the
                field without the control fighting them.
              */
              const settled = Math.min(Math.max(1, quantity), maxQuantity(pkg));
              setQuantityText(String(settled));
            }}
          />
        </label>
      ) : null}

      {/*
        NET, TAX, TOTAL — and the total is the one in bold, because it is the
        one that leaves the account.
      */}
      {total && pkg?.taxed ? (
        <dl className="srOnly" data-testid="buy-totals">
          <div>
            <dt>{t('buy.net')}</dt>
            <dd data-testid="buy-net">{money(format, total.net, price?.currency ?? null)}</dd>
          </div>
          <div>
            <dt data-testid="buy-tax-label">
              {/*
                `exempt` is a STATUS, not an amount. "VAT 0%" and "not liable
                for VAT" are different sentences and only one of them is true
                of a business that is exempt.
              */}
              {pkg.taxed.exempt
                ? t('buy.exempt')
                : /*
                   * ════════════════════════════════════════════════════════
                   * ★★ OUR LABEL, NOT THE PLATFORM'S — IT IS LOCALISED TO THE
                   *    TENANT AND NOT TO THE READER
                   * ════════════════════════════════════════════════════════
                   * `taxed.label` was preferred, and for an Israeli tenant the
                   * platform sends **`מע"מ`** — so a browser walk found Hebrew
                   * in the money summary of the English screen. It is not a
                   * hardcoded string in this app: it is a correct label for
                   * the wrong audience.
                   *
                   * The reader chose this page's language. A label the
                   * platform localised for the ACCOUNT cannot be the primary
                   * display string on a screen whose language the reader
                   * picked, so our own translation leads and carries the rate.
                   *
                   * ⚠ AND THE FIRST VERSION OF THIS COMMENT DESCRIBED A
                   * SECOND BEHAVIOUR THE CODE DOES NOT HAVE. It said the
                   * platform's label "is shown beside the rate when it says
                   * something our translation does not, and isolated". It is
                   * not shown at all — `taxed.label` appears nowhere in this
                   * file but in this comment. I wrote the mitigation into the
                   * prose and not into the code, and a reader checking whether
                   * a non-VAT jurisdiction is handled would have been told yes.
                   *
                   * The real position: we discard it. A jurisdiction whose tax
                   * is not VAT is mislabelled by `buy.taxFallback`, the rate
                   * stays correct, and that is a known limitation rather than a
                   * handled case. Recorded in `contracts/README.md`.
                   */
                  t('buy.taxFallback', { pct: pkg.taxed.percent })}
            </dt>
            <dd data-testid="buy-tax">{money(format, total.tax, price?.currency ?? null)}</dd>
          </div>
          <div className={styles.buyTotalRow}>
            <dt>{t('buy.total')}</dt>
            <dd data-testid="buy-total">{money(format, total.gross, price?.currency ?? null)}</dd>
          </div>
        </dl>
      ) : (
        /*
          No tax block. NOT zero tax: `taxSummaryForTenant` REFUSES rather
          than defaulting when a profile has declared no country, because
          "defaulting to 0% would charge an Israeli customer no VAT". So the
          total is unknown, and an unknown total is not a total.
        */
        <p className={styles.buyUnknownTotal} data-testid="buy-total-unknown">
          {t('buy.totalUnknown')}
        </p>
      )}

      {/*
        ════════════════════════════════════════════════════════════════════
        ★★ THE `Button` PRIMITIVE. THIS RENDERED AS CENTRED PLAIN TEXT.
        ════════════════════════════════════════════════════════════════════
        It was a raw `<button className={styles.buyButton}>`, and
        `Billing.module.css` has **only** a `.buyButton:disabled` rule — no
        base rule at all. So the control had no background, no border and no
        padding: on the screen that takes money, the thing you press did not
        look like a thing you press.
        A hand-rolled control whose only style is its disabled state is how
        that happens. The primitive carries both states, and `variant="primary"`
        is right here because buying is the panel's one action.
      */}
      {/*
        02: ONE button, the money in its label — "Pay ₪290 · incl. VAT
        ₪343.20". The net, tax and total stay above for a screen reader.
      */}
      <div className={styles.buyActions}>
        <Button
          variant="primary"
          data-testid="buy-button"
          disabled={isPending || blocked !== null || !total}
          onClick={buy}
        >
          {isPending
            ? t('buy.buying')
            : total && pkg?.taxed
              ? pkg.taxed.exempt
                ? t('buy.payExempt', { net: money(format, total.net, price?.currency ?? null) })
                : t('buy.pay', {
                    net: money(format, total.net, price?.currency ?? null),
                    gross: money(format, total.gross, price?.currency ?? null),
                  })
              : t('buy.action')}
        </Button>
        <Link href="/settings/billing" className={styles.buyCancel}>
          {t('autoPurchase.cancel')}
        </Link>
        {receiptTo ? (
          <span className={styles.buyReceipt} data-testid="buy-receipt">
            {t('buy.receiptTo', { email: receiptTo })}
          </span>
        ) : null}
      </div>

      {/*
        TWO REASONS, TWO REPAIRS. "Nobody to invoice" and "nothing to charge"
        are different problems with different fixes, and one sentence for both
        sends half of them to do the wrong thing.
      */}
      {blocked ? (
        <p className={styles.buyBlocked} data-testid="buy-blocked">
          {blocked === 'no_account' ? t('buy.blocked.noAccount') : t('buy.blocked.noCard')}
        </p>
      ) : null}

      {outcome?.ok === true ? (
        <p className={styles.buyOk} data-testid="buy-ok">
          {t('buy.bought', { credits: format.number(outcome.units ?? 0) })}
        </p>
      ) : null}

      {outcome?.ok === false ? (
        <p
          className={outcome.kind === 'unsettled' ? styles.buyUnsettled : styles.buyError}
          data-testid={outcome.kind === 'unsettled' ? 'buy-unsettled' : 'buy-error'}
        >
          {/*
            ════════════════════════════════════════════════════════════════
            ★ `unsettled` IS NOT A FAILURE AND MUST NOT OFFER A RETRY.
            ════════════════════════════════════════════════════════════════
            The route answers 409 rather than 402 deliberately: "a
            payment-required response invites the customer to try again, and
            they may already have been charged."

            So this branch says a charge MAY have been made, tells them not to
            try again, and offers no button that would. Flattening these into
            "Something went wrong, try again" takes money twice.
          */}
          {/*
            ★★ AND `failed` NO LONGER BORROWS THE DECLINED SENTENCE.
            It used to be the fallback, so a network drop, a 500 and a
            response that failed its contract all said *"nothing was
            charged"* — a claim about the customer's money made from an error
            that says nothing about it. A contract failure can follow a 200 in
            which the card WAS charged.
          */}
          {outcomeSentence(outcome, t)}
        </p>
      ) : null}
    </section>
  );
}

/**
 * One sentence per outcome, and every outcome named.
 *
 * A `switch` with no default, so a new `BuyOutcome` member fails the build
 * here instead of silently inheriting whichever branch happens to be last —
 * which is how `failed` came to tell people their card was not charged.
 */
function outcomeSentence(
  outcome: Extract<BuyOutcome, { ok: false }>,
  t: ReturnType<typeof useTranslations<'billing'>>,
): string {
  switch (outcome.kind) {
    case 'unsettled':
      return t('buy.unsettled');
    case 'no_billable_entity':
      return t('buy.blocked.noAccount');
    case 'too_many':
      // The cap travels with the refusal now, so the sentence can name it.
      return outcome.max === null ? t('buy.tooMany') : t('buy.tooManyMax', { max: outcome.max });
    case 'not_purchasable':
      return t('buy.notPurchasable');
    case 'declined':
      return t('buy.declined');
    case 'failed':
      return t('buy.failed');
  }
}

/**
 * Is this attempt over, one way or the other?
 *
 * Deliberately a whitelist rather than `kind !== 'unsettled'`: a new outcome
 * added to `BuyOutcome` defaults to NOT settled, so an unknown state keeps the
 * key instead of releasing it. The wrong answer in that direction costs a
 * purchase somebody can repeat; the wrong answer in the other direction
 * charges a card twice.
 */
function isSettled(outcome: BuyOutcome): boolean {
  if (outcome.ok) return true;
  return (
    outcome.kind === 'declined' ||
    outcome.kind === 'no_billable_entity' ||
    outcome.kind === 'too_many' ||
    outcome.kind === 'not_purchasable'
  );
}

function money(
  format: ReturnType<typeof useFormatter>,
  amount: number,
  currency: string | null,
): string {
  // No currency means no claim about one. A bare number beside a ₪ somebody
  // assumed is how a price becomes wrong without anybody editing it.
  if (!currency) return format.number(amount, { maximumFractionDigits: 2 });
  return format.number(amount, { style: 'currency', currency, maximumFractionDigits: 2 });
}
