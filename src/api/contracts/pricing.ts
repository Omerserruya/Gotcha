import { z } from 'zod';

/**
 * Plan, price and changing it — screen 17b.
 *
 * `GET /api/billing/pricing`, `/pricing/current`, `/pricing/packages`,
 * `POST /pricing/quote`, `POST /pricing/change`.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * A CHANGE IS TWO DIFFERENT PROMISES, AND ONLY ONE HAPPENS NOW
 * ════════════════════════════════════════════════════════════════════════════
 * `changePlan` returns `applied: "immediate"` or `applied: "scheduled"`.
 *
 * Immediate means charged now, plan flipped, credits topped up. Scheduled
 * means **nothing changes at all** until `effectiveAt` — the service says so
 * in its own words: *"The current plan, its features, its limits and its
 * credits all stay exactly as they are until then."*
 *
 * That sentence is the reassurance a person wants before clicking, and it is
 * true, so the screen says it. One confirmation for both outcomes would make
 * one of them a lie.
 *
 * **Every change available to this tenant is the deferred kind.** They are on
 * `ai_voice` at $1,499; the other active plans are `foundation` at $39 and
 * `ai_workforce` at $97. Their period ends **2027-09-08**, so a change chosen
 * today lands eleven and a half months out, so every rendering of
 * `effectiveAt` carries the YEAR. Eleven and a half months is not a date
 * anybody assumes, and "8 September" will be read as this year by everybody.
 * The component test asserts the year is present rather than asserting a
 * format.
 * ════════════════════════════════════════════════════════════════════════════
 */

/* ── What is already scheduled ───────────────────────────────────────────── */

/**
 * The four kinds, which are four different sentences.
 *
 * `CANCEL` is in here, and *"your subscription ends"* is not *"your plan
 * changes"*. A screen that renders the type as one string gets that wrong in
 * the direction that matters most.
 */
export const PENDING_CHANGE_TYPES = ['DOWNGRADE', 'CANCEL', 'UPGRADE', 'VOLUME_CHANGE'] as const;
export type PendingChangeType = (typeof PENDING_CHANGE_TYPES)[number];

export const pendingChangeSchema = z.object({
  changeType: z.enum(PENDING_CHANGE_TYPES),
  targetPlanKey: z.string().nullable().default(null),
  effectiveAt: z.string().nullable().default(null),
  /**
   * Set when the scheduler has already applied it.
   *
   * **The row is marked, never deleted** — `subscription.service.ts:524` is an
   * `update` setting `appliedAt`, and the scheduler's own query is
   * `where: { appliedAt: null, effectiveAt: { lte: now } }`. The relation is
   * loaded unconditionally by `getSubscriptionForTenant`, so a change that
   * happened months ago still arrives on every response.
   *
   * **So a present `pendingChange` is not a pending change.** Reading it as
   * one renders "changes to Foundation on 8 September 2027" forever, starting
   * the day after it did.
   */
  appliedAt: z.string().nullable().default(null),
});

export type PendingChange = z.infer<typeof pendingChangeSchema>;

/** Is anything actually scheduled? The scheduler's own predicate. */
export function isStillPending(change: PendingChange | null | undefined): boolean {
  return !!change && change.appliedAt === null;
}

/* ── Money ───────────────────────────────────────────────────────────────── */

/**
 * Every catalogue price is NET.
 *
 * The routes are insistent about this — *"the three numbers travel together or
 * the page shows a total nobody can check against the one on their
 * statement"*. So tax is carried with the price and never dropped, which is
 * the invoices problem avoided in advance rather than discovered later.
 */
export const taxSchema = z
  .object({
    ratePct: z.number().nullable().default(null),
    label: z.string().nullable().default(null),
  })
  .nullable()
  .default(null);

/**
 * Displayed currency is not necessarily charged currency.
 *
 * `/billing/pricing` returns `display`, `chargedCurrency` and
 * `isEstimatedConversion`, and the route's comment says the UI *"keys its
 * 'estimated conversion' label off this, rather than assuming which currency
 * is charged"*. A price shown in ILS may leave the card in USD.
 */
export const currencyBlockSchema = z
  .object({
    base: z.string().default('USD'),
    display: z.string().default('USD'),
    chargedCurrency: z.string().default('USD'),
    isEstimatedConversion: z.boolean().default(false),
    fx: z
      .object({
        rate: z.number().nullable().default(null),
        rateDate: z.string().nullable().default(null),
        /** A fallback rate is not a rate. Shown as such or not shown. */
        isFallback: z.boolean().default(false),
      })
      .nullable()
      .default(null),
  })
  .default({
    base: 'USD',
    display: 'USD',
    chargedCurrency: 'USD',
    isEstimatedConversion: false,
    fx: null,
  });

export type CurrencyBlock = z.infer<typeof currencyBlockSchema>;

/** Is the rendered price an estimate rather than the amount charged? */
export function priceIsConverted(currency: CurrencyBlock): boolean {
  return currency.isEstimatedConversion || currency.display !== currency.chargedCurrency;
}

/** Is the conversion itself resting on a fallback rate? */
export function rateIsFallback(currency: CurrencyBlock): boolean {
  return currency.fx?.isFallback === true;
}

/* ── Credit packages ─────────────────────────────────────────────────────── */

/**
 * A pack's price, as the two fields the wire actually carries.
 *
 * One accessor so no component reassembles the pair, and so the "we were not
 * told" case has one shape: a price without a currency is not a price, and
 * `money()` already refuses to invent one.
 */
export function packagePrice(pkg: {
  readonly price: string | number | null;
  readonly currency: string | null;
}): { readonly amount: number; readonly currency: string } | null {
  if (pkg.price === null || pkg.currency === null) return null;
  const amount = typeof pkg.price === 'number' ? pkg.price : Number.parseFloat(pkg.price);
  return Number.isFinite(amount) ? { amount, currency: pkg.currency } : null;
}

/**
 * `price` arrives in two shapes. Bare (`"290.00"` + `currency`) is the older
 * one; `GET /billing/pricing/packages` now sends the shared `DisplayPrice` —
 * `{ base, display, isEstimatedConversion, chargedCurrency, fx }` — and no
 * `currency` beside it. A contract that knew only the first rejected every
 * package, and 17d said "could not load" over four sellable packs.
 *
 * Both are read; the DISPLAY amount is the one drawn, with its currency.
 */
function flattenPrice(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const pkg = raw as Record<string, unknown>;
  const price = pkg.price as { display?: { amount?: unknown; currency?: unknown } } | null;
  if (typeof price !== 'object' || price === null || !price.display) return raw;
  return {
    ...pkg,
    price: price.display.amount ?? null,
    currency: pkg.currency ?? price.display.currency ?? null,
  };
}

export const creditPackageSchema = z.preprocess(
  flattenPrice,
  z.object({
    key: z.string(),
    name: z.string(),
    /** The platform's own Hebrew. One string, one owner — as with the disclaimer. */
    nameHe: z.string().nullable().default(null),
    credits: z.number().default(0),
    /**
     * ════════════════════════════════════════════════════════════════════════
     * ★★ FLAT SIBLINGS, NOT A NESTED OBJECT — AND THAT IS WHY NO PACK HAD A PRICE
     * ════════════════════════════════════════════════════════════════════════
     * This read `price: displayPriceSchema` — an object with `amount` and
     * `currency`. The route sends
     *
     *     { key, name, nameHe, credits: p.units, price: String(p.price),
     *       currency: p.currency, … }
     *
     * so `price` is a **string** and `currency` is its **sibling**. The object
     * schema could not parse a string, the `.default({ amount: null, currency:
     * null })` fired, and a browser walk found **no price on any pack and no
     * currency symbol on the totals** — one cause, reported as two defects.
     *
     * `money()` was behaving correctly throughout: *"no currency means no claim
     * about one"*. It was told there was none.
     *
     * ── AND I CHECKED THE WRONG ROUTE FIRST ──
     * `/billing/credits/packages` sends the model raw, where the field is
     * `units`. This app calls `/billing/pricing/packages`, which maps
     * `credits: p.units` — so `credits` was right all along and "fixing" it
     * would have broken a working line.
     */
    price: z.union([z.string(), z.number()]).nullable().default(null),
    currency: z.string().nullable().default(null),
    discountLabel: z.string().nullable().default(null),
    /**
     * `NEVER` · `DAYS_AFTER_PURCHASE` · `PERIOD_END`.
     *
     * Carried because it is the one place per-credit expiry reaches a customer.
     * The credit-summary route strips `expiresAt` from the lots, so after the
     * purchase nothing can tell them when these credits die — see
     * `credits.ts`. Before the purchase, this is it.
     */
    expiryPolicy: z.enum(['NEVER', 'DAYS_AFTER_PURCHASE', 'PERIOD_END']).default('NEVER'),
    expiryDays: z.number().nullable().default(null),
    /**
     * ★ WHAT WILL ACTUALLY BE CHARGED — AND IT IS NOT THE PRICE ON THE TILE.
     *
     * Catalogue prices are NET. The route's own comment says the tax travels
     * with them so "the confirm dialog can state the amount that will actually
     * be charged rather than the one on the tile", and it has been on the wire
     * all along — our schema is `object`, so it was stripped at the boundary
     * and screen 17 could only ever show the net figure.
     *
     * Showing a merchant ₪100 and charging ₪118 is the single worst thing a
     * buy screen can do, and it is the reassuring direction.
     *
     * `exempt` is not the same as 0%: one is a status, the other an amount.
     */
    taxed: z
      .object({
        net: z.string(),
        tax: z.string(),
        gross: z.string(),
        percent: z.number().default(0),
        label: z.string().nullable().default(null),
        countryCode: z.string().nullable().default(null),
        exempt: z.boolean().default(false),
      })
      .nullable()
      .default(null),
    /**
     * A per-package cap the SERVER enforces — `quantity_exceeds_maximum` with
     * the max in `detail`. Also carried all along and also stripped, so the
     * quantity control had no way to know its own limit and would have let
     * somebody pick a number the purchase then refused.
     */
    maxPurchaseQuantity: z.number().nullable().default(null),
  }),
);

/* ── Buying ──────────────────────────────────────────────────────────────── */

/**
 * What one purchase will cost, in the currency it is charged in.
 *
 * Computed from `taxed`, never re-derived from `price` and a rate: the server
 * rounds each component to its own scale, and a UI that multiplies and rounds
 * again produces a total that differs from the invoice by a penny — which is
 * the kind of discrepancy nobody can explain afterwards.
 *
 * `null` when the package carries no tax block. That is not zero tax: it
 * means we were not told, and `taxSummaryForTenant` REFUSES rather than
 * defaulting when a profile has declared no country — "defaulting to 0% would
 * charge an Israeli customer no VAT and leave them" with a bill nobody quoted.
 */
export function chargeable(
  pkg: CreditPackage,
  quantity: number,
): { readonly net: number; readonly tax: number; readonly gross: number } | null {
  if (!pkg.taxed) return null;
  const n = Math.max(1, Math.floor(quantity));
  const num = (v: string) => Number.parseFloat(v);
  const net = num(pkg.taxed.net);
  const tax = num(pkg.taxed.tax);
  const gross = num(pkg.taxed.gross);
  if (!Number.isFinite(net) || !Number.isFinite(tax) || !Number.isFinite(gross)) return null;
  return { net: net * n, tax: tax * n, gross: gross * n };
}

/** The server's cap, or a sane one when it did not state a cap. */
export function maxQuantity(pkg: CreditPackage): number {
  return pkg.maxPurchaseQuantity && pkg.maxPurchaseQuantity > 0 ? pkg.maxPurchaseQuantity : 10;
}

/**
 * The outcome of `POST /billing/credits/buy`.
 *
 * ★ `outcomeUnknown` IS ANSWERED 409, NOT 402, AND THE ROUTE SAYS WHY:
 * *"A payment-required response invites the customer to try again, and they
 * may already have been charged."* The same rule as `mayRetry` on plan
 * changes, in the one place where a double charge is a single click away.
 */
export const buyResultSchema = z.object({
  success: z.boolean().default(false),
  units: z.number().nullable().default(null),
  invoiceId: z.string().nullable().default(null),
  failureCode: z.string().nullable().default(null),
  /**
   * ════════════════════════════════════════════════════════════════════════
   * ★★ DEFAULTS TO `true`, AND THE COMMENT ABOVE THIS FIELD IS WHY
   * ════════════════════════════════════════════════════════════════════════
   * It used to default to `false` — a schema asserting that the outcome IS
   * known, on the one field whose entire purpose is to admit that it is not.
   * A body that arrived without it read as *"we know what happened"*, fell
   * through to `declined`, and the screen offered a retry on a charge that
   * may already have gone through.
   *
   * The paragraph four lines up names that exact danger: *"A payment-required
   * response invites the customer to try again, and they may already have
   * been charged."* **The comment was correct and the line underneath armed
   * the thing it warned about** — which is worse than a comment that merely
   * describes the code wrongly, because a reader checking this field would
   * read it, agree, and move on. The comment certified the defect.
   *
   * ── AND REQUIRING IT WOULD HAVE BEEN THE WRONG FIX ──
   * A missing required field throws, `buyCreditPack`'s catch sees a contract
   * error rather than a 409, and it returns `kind: 'failed'` — which renders
   * a retry. That moves the defect from the schema into the error handler,
   * where it is harder to see and identical in effect.
   *
   * **The safe default for "is this unknown" is `true`.** Absent means we
   * could not read the answer, which is precisely when we do not know
   * whether the customer was charged. `buyCreditPack` already routes this to
   * `unsettled`, the state built for it, and the retry is suppressed with no
   * new handling at all.
   */
  outcomeUnknown: z.boolean().default(true),
});

export type BuyResult = z.infer<typeof buyResultSchema>;

export type CreditPackage = z.infer<typeof creditPackageSchema>;

/**
 * `{ packages: [], eligible: false }` and `{ packages: [], eligible: true }`
 * are **different facts**.
 *
 * The first is a plan that cannot buy credit packages at all
 * (`creditPackagesEligible: false`). The second is a plan that can, with
 * nothing currently on sale. *"Your plan cannot buy credits"* and *"there is
 * nothing to buy right now"* are different sentences, and only one of them is
 * about the customer's plan.
 *
 * Fourth time on this project that two states hid behind one empty.
 */
export const packagesResponseSchema = z.object({
  packages: z.array(creditPackageSchema).default([]),
  eligible: z.boolean().default(true),
  tax: taxSchema,
});

export type PackagesResponse = z.infer<typeof packagesResponseSchema>;

export function planCannotBuyPackages(response: PackagesResponse): boolean {
  return !response.eligible;
}

export function noneOnSale(response: PackagesResponse): boolean {
  return response.eligible && response.packages.length === 0;
}

/* ── Changing the plan ───────────────────────────────────────────────────── */

/**
 * The three ways an upgrade fails, and the one that must never say so.
 *
 * `upgrade_payment_outcome_unknown` is raised **after** a charge whose result
 * the provider has not settled. The plan is not flipped and a
 * `payment.reconciliation_required` event is emitted. The service states the
 * reason for not calling it a failure:
 *
 * > *"telling them the payment failed would be worse than saying nothing:
 * > they may have been charged, and 'failed' invites them to try again."*
 *
 * So for this code the screen must not say *failed* and must not offer a
 * retry. Flattening three outcomes into "Something went wrong, try again" —
 * which is what a redesign does to error states — can charge somebody twice.
 */
export const OUTCOME_UNKNOWN = 'upgrade_payment_outcome_unknown';
export const PAYMENT_FAILED_PREFIX = 'upgrade_payment_failed';

export type ChangeFailure = 'outcome_unknown' | 'payment_failed' | 'other';

export function classifyChangeError(code: string | null | undefined): ChangeFailure {
  if (code === OUTCOME_UNKNOWN) return 'outcome_unknown';
  if (code?.startsWith(PAYMENT_FAILED_PREFIX)) return 'payment_failed';
  return 'other';
}

/** May the screen offer to try again? Never on an unsettled charge. */
export function mayRetry(code: string | null | undefined): boolean {
  return classifyChangeError(code) !== 'outcome_unknown';
}

export const changeResultSchema = z.object({
  ok: z.literal(true),
  applied: z.enum(['immediate', 'scheduled']),
  effectiveAt: z.string().nullable().default(null),
  includedCredits: z.number().nullable().default(null),
});

export type ChangeResult = z.infer<typeof changeResultSchema>;

/**
 * Will an upgrade be declined before it starts?
 *
 * `changePlan` resolves the card as
 * `billingProfile?.paymentMethods[0]?.id ?? "nocard"` and charges the prorated
 * difference **before** granting anything. With no payment method the charge
 * cannot succeed, so the upgrade fails having changed nothing.
 *
 * Naming it up front is not a warning for its own sake — the idempotency key
 * is scoped to the payment method *deliberately*, so *"a failed attempt must
 * not permanently block a retry after the customer adds a valid card"*. Add a
 * card, then upgrade, is a path that genuinely works.
 */
export function upgradeWillBeDeclined(paymentMethodCount: number): boolean {
  return paymentMethodCount === 0;
}

/**
 * The credits an upgrade actually grants.
 *
 * `delta = Math.max(0, q.includedCredits - bal.includedAllowance)` — a top-up
 * against the existing allowance, expiring at the **current** period end.
 * So "upgrade and get 7,000 credits" is wrong twice: wrong amount, and they
 * die at the old boundary rather than starting a fresh period.
 */
export function creditsGrantedOnUpgrade(targetIncluded: number, currentAllowance: number): number {
  return Math.max(0, targetIncluded - currentAllowance);
}

/**
 * One plan of `GET /billing/pricing`'s `plans` — the catalog 17b's cards are
 * drawn from: the public plans plus any custom one negotiated for this
 * tenant, each with its price, its credits, its features and the
 * conversations its credits come to.
 *
 * Read per plan (`catalogPlans`), so one plan the contract cannot read costs
 * that card, not the screen.
 */
export const catalogPlanSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  nameHe: z.string().nullable().default(null),
  billingInterval: z.string().nullable().default(null),
  salesOnly: z.boolean().default(false),
  basePrice: z
    .object({
      display: z.object({ amount: z.string(), currency: z.string() }),
    })
    .nullable()
    .default(null),
  includedCredits: z.number().default(0),
  features: z
    .array(
      z.object({
        key: z.string(),
        nameEn: z.string(),
        nameHe: z.string().nullable().default(null),
        included: z.boolean().default(false),
      }),
    )
    .default([]),
  estimate: z
    .object({
      chat: z
        .object({
          monthly: z.number().nullable().default(null),
          /**
           * `DECLARED_VOLUME` is the chat volume the plan SELLS by default —
           * 250 a month on every plan here, whatever its credits — and
           * `CREDIT_RATIO` is the credits divided by an assumption. Only the
           * second is "what these credits come to".
           */
          basis: z.enum(['DECLARED_VOLUME', 'CREDIT_RATIO']).nullable().catch(null).default(null),
        })
        .nullable(),
    })
    .nullable()
    .default(null),
});

export type CatalogPlan = z.infer<typeof catalogPlanSchema>;

export function catalogPlans(raw: unknown): CatalogPlan[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((p) => {
    const parsed = catalogPlanSchema.safeParse(p);
    return parsed.success ? [parsed.data] : [];
  });
}
