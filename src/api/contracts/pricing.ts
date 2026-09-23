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

const displayPriceSchema = z.object({
  amount: z.union([z.string(), z.number()]).nullable().default(null),
  currency: z.string().nullable().default(null),
});

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

export const creditPackageSchema = z.object({
  key: z.string(),
  name: z.string(),
  /** The platform's own Hebrew. One string, one owner — as with the disclaimer. */
  nameHe: z.string().nullable().default(null),
  credits: z.number().default(0),
  price: displayPriceSchema.default({ amount: null, currency: null }),
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
});

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
