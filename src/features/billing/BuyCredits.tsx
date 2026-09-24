'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useMemo, useState, useTransition } from 'react';

import {
  chargeable,
  maxQuantity,
  type CreditPackage,
  type PackagesResponse,
} from '@/api/contracts/pricing';

import { buyCreditPack, type BuyOutcome } from './actions';
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
 * appearance, and the protection silently gone. So it is memoised against
 * the package and quantity: change either and it is genuinely a different
 * purchase.
 */
export function BuyCredits({
  packages,
  billable,
  hasPaymentMethod,
}: {
  readonly packages: PackagesResponse | null;
  /**
   * Is there anything to bill? `profileReading(profile) !== 'no_account'`.
   * Distinct from having a card: one is who the invoice is made out to, the
   * other is what pays it, and they fail with different repairs.
   */
  readonly billable: boolean;
  readonly hasPaymentMethod: boolean;
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

  const intentKey = useMemo(
    () => `buy:${chosen}:${quantity}:${Math.floor(Date.now() / 60_000)}`,
    [chosen, quantity],
  );

  if (!packages || sellable.length === 0) return null;

  const total = pkg ? chargeable(pkg, quantity) : null;
  const blocked = !billable ? 'no_account' : !hasPaymentMethod ? 'no_card' : null;

  function buy() {
    if (!pkg || blocked) return;
    setOutcome(null);
    startTransition(async () => {
      setOutcome(await buyCreditPack(pkg!.key, quantity, intentKey));
    });
  }

  return (
    <section className={styles.block} data-testid="buy-credits">
      <h3 className={styles.buyHeading}>{t('buy.heading')}</h3>

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
              <span className={styles.buyPackCredits}>
                {t('pricing.packages.credits', { credits: format.number(p.credits) })}
              </span>
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
              <span className={styles.buyPackExpiry} data-testid={`buy-pack-expiry-${p.key}`}>
                {p.expiryPolicy === 'DAYS_AFTER_PURCHASE'
                  ? t('pricing.packages.expiry.DAYS_AFTER_PURCHASE', { days: p.expiryDays ?? 0 })
                  : t(`pricing.packages.expiry.${p.expiryPolicy}`)}
              </span>
            </label>
          </li>
        ))}
      </ul>

      {pkg ? (
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
        <dl className={styles.buyTotals} data-testid="buy-totals">
          <div>
            <dt>{t('buy.net')}</dt>
            <dd data-testid="buy-net">{money(format, total.net, pkg.price.currency)}</dd>
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
                : (pkg.taxed.label ?? t('buy.taxFallback', { pct: pkg.taxed.percent }))}
            </dt>
            <dd data-testid="buy-tax">{money(format, total.tax, pkg.price.currency)}</dd>
          </div>
          <div className={styles.buyTotalRow}>
            <dt>{t('buy.total')}</dt>
            <dd data-testid="buy-total">{money(format, total.gross, pkg.price.currency)}</dd>
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

      <button
        type="button"
        className={styles.buyButton}
        data-testid="buy-button"
        disabled={isPending || blocked !== null || !total}
        onClick={buy}
      >
        {isPending ? t('buy.buying') : t('buy.action')}
      </button>

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
          {outcome.kind === 'unsettled'
            ? t('buy.unsettled')
            : outcome.kind === 'no_billable_entity'
              ? t('buy.blocked.noAccount')
              : outcome.kind === 'too_many'
                ? t('buy.tooMany')
                : t('buy.declined')}
        </p>
      ) : null}
    </section>
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
