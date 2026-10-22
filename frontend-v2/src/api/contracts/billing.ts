import { z } from 'zod';

import { pendingChangeSchema } from './pricing';

/**
 * Settings · Usage & billing - screen 17.
 *
 * *"Usage as runway, not credits. The user should know how long they are good
 * for, not do arithmetic."*
 *
 * Three things the design draws that nothing behind them can produce:
 *
 *   - **"184 hours your team didn't spend, ₪84,200 of outreach revenue."**
 *     Nothing computes either figure. Dropped by Omer.
 *   - **"bills ₪0.40 per extra conversation."** There is no overage rate field
 *     anywhere in the schema, and no overage concept. Writing the sentence
 *     without the number would still assert billing behaviour from a mockup,
 *     which on the billing screen is the worst possible place to guess.
 *   - **"Set a spending cap."** No such field. `/api/billing/auto-purchase` is
 *     the AI-Units auto-purchase ceiling - a different resource with different
 *     consequences - and presenting it as a spending cap would be this
 *     screen's version of the per-person money limits.
 */

/**
 * `GET /api/usage/allowance` - enveloped in `data`.
 *
 * **The projection is computed server-side and must not be re-derived here.**
 * The route's own comment gives the reason: *"A client working out its own
 * run-rate would put a different date on Home than the one billing acts on,
 * and the first time those disagree is the last time anyone believes either."*
 * Home already draws from this; the two surfaces must agree because they read
 * the same answer, not because they run the same formula.
 *
 * Path taken from the mount (`usage-allowance.ts:30`), not from the filename -
 * this is one of the three routes in the platform that split a compound name
 * with a slash rather than a hyphen.
 */
export const allowanceSchema = z.object({
  /** Conversations counted in this period, excluding test conversations. */
  used: z.number().default(0),
  /**
   * `null` when the plan carries no conversation allowance - which is the case
   * on the demo tenant, whose subscription has no chat volume option selected.
   *
   * Not zero, and not "unlimited": the plan simply does not meter this. The
   * screen says so rather than drawing a bar against a number it does not
   * have.
   */
  limit: z.number().nullable().default(null),
  periodStart: z.string(),
  periodEnd: z.string(),
  /** `null` when there is no limit to exhaust, or the pace cannot support one. */
  projectedExhaustionAt: z.string().nullable().default(null),
});

export type Allowance = z.infer<typeof allowanceSchema>;

/**
 * `GET /api/billing/subscription`.
 *
 * **Answers bare `{ subscription }`, NOT `{ data }`.** Every other billing
 * route in this app is enveloped; this one is not, and the transport only
 * unwraps `data` when it is present. Noted here because the next person to
 * touch it will meet the inconsistency before they meet any message about it.
 *
 * `snapshotPrice` and `snapshotCurrency` are what the tenant is actually
 * charged - the demo tenant is `$1,499.00 USD`. The screen renders that
 * currency and does not convert: a symbol the row does not carry is a number
 * nobody agreed to.
 */
export const subscriptionSchema = z.object({
  planKey: z.string(),
  status: z.string(),
  snapshotPrice: z.union([z.string(), z.number()]).nullable().optional(),
  snapshotCurrency: z.string().nullable().optional(),
  currentPeriodEnd: z.string().nullable().optional(),
  /** 17's "per month / per year" is only said when the period agrees with it. */
  currentPeriodStart: z.string().nullable().optional(),
  /** 17's "since March 2025": when this subscription began. */
  createdAt: z.string().nullable().optional(),
  cancelAtPeriodEnd: z.boolean().default(false),
  billingInterval: z.string().nullable().optional(),
  /**
   * A plan change scheduled for renewal - loaded by `getSubscriptionForTenant`,
   * whose comment says it is included *"so the Billing page can show 'changes
   * to X at renewal' honestly"*.
   *
   * This used to be `{ targetPlanKey }` alone, which was not enough to say
   * anything honest with. It omitted **`changeType`**, so a scheduled CANCEL
   * was indistinguishable from a downgrade; **`effectiveAt`**, so the screen
   * could name the plan but not the date; and **`appliedAt`**, without which
   * a change the scheduler ran months ago still reads as pending - the row is
   * marked, never deleted. See `pricing.ts`.
   */
  pendingChange: pendingChangeSchema.nullable().optional(),
});

export const subscriptionResponseSchema = z.object({
  subscription: subscriptionSchema.nullable().default(null),
});

export type Subscription = z.infer<typeof subscriptionSchema>;

/**
 * `GET /api/billing/plans` - bare `{ plans }`, like its sibling.
 *
 * **The subscription carries `planKey`, not a plan name.** `ai_voice` is a
 * machine identifier and must never be the most prominent line on a billing
 * screen - the same class of error as rendering a cuid as an object name.
 *
 * `Plan` carries `name` and `nameHe`, so the name is also TRANSLATABLE, which
 * a key can never be. Resolving it here rather than asking the backend to join
 * it is deliberate: this route already exists, is already tenant-scoped, and
 * its own comment says it deliberately includes RETIRED plans *"so a customer
 * still on one keeps seeing their own plan's name"* - it was built for exactly
 * this lookup.
 *
 * **`object`, not `looseObject`:** the route returns whole `Plan` rows with
 * `entitlements`, `volumeOptions` and pricing internals. A billing screen
 * needs three fields.
 */
export const planSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  nameHe: z.string().nullable().optional(),
});

export const plansResponseSchema = z.object({
  plans: z.array(planSchema).default([]),
});

export type Plan = z.infer<typeof planSchema>;

/**
 * The plan's name in the reader's language, falling back honestly.
 *
 * A plan the list does not contain returns `null` rather than its key - the
 * caller decides whether showing a machine identifier is better than showing
 * nothing, and on this screen it is: an unrecognised plan is still the plan
 * they are paying for.
 */
export function planNameFor(
  plans: readonly Plan[],
  key: string | null | undefined,
  locale: string,
): string | null {
  if (!key) return null;
  const plan = plans.find((p) => p.key === key);
  if (!plan) return null;
  // Hebrew only when there IS a Hebrew name; an empty one falls back rather
  // than rendering a blank where a plan name belongs.
  if (locale.startsWith('he') && plan.nameHe?.trim()) return plan.nameHe.trim();
  return plan.name;
}

/**
 * An invoice - **contracted, not yet served.**
 *
 * `Invoice` carries everything the design draws, including `providerPdfUrl`
 * for the PDF link, and there is no tenant-facing list route: the billing
 * service's non-admin routes are credits, auto-purchase, checkout and Shopify
 * state. Four real invoices sit on the demo tenant, unreachable.
 */
export const invoiceSchema = z.object({
  id: z.string().min(1),
  amount: z.union([z.string(), z.number()]),
  currency: z.string().default('ILS'),
  status: z.string(),
  issuedAt: z.string().nullable().optional(),
  /** The provider's own PDF. Absent for an invoice not yet issued. */
  providerPdfUrl: z.string().nullable().optional(),
});

/** `PaymentMethod` - `brand` and `last4` give the design's "Visa · 4417". */
export const paymentMethodSchema = z.object({
  brand: z.string().nullable().optional(),
  last4: z.string().nullable().optional(),
});

export const billingSummarySchema = z.object({
  invoices: z.array(invoiceSchema).default([]),
  paymentMethod: paymentMethodSchema.nullable().default(null),
});

export type Invoice = z.infer<typeof invoiceSchema>;
export type BillingSummary = z.infer<typeof billingSummarySchema>;

/**
 * What the price is per - said only when the period agrees with the interval.
 *
 * The demo tenant's ACTIVE row reads `billingInterval: MONTHLY` over a period
 * from 2026-09-08 to 2027-09-08. "$1,499 a month" beside a year-long period
 * would be a claim about money nobody can check, so a disagreement says
 * nothing and the bare price stands.
 */
export function pricePer(subscription: Subscription): 'month' | 'year' | null {
  const start = subscription.currentPeriodStart ? Date.parse(subscription.currentPeriodStart) : NaN;
  const end = subscription.currentPeriodEnd ? Date.parse(subscription.currentPeriodEnd) : NaN;
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const days = (end - start) / (24 * 60 * 60 * 1000);
  const interval = subscription.billingInterval?.toUpperCase();
  if (interval === 'MONTHLY' && days >= 27 && days <= 32) return 'month';
  if ((interval === 'YEARLY' || interval === 'ANNUAL') && days >= 360 && days <= 370) {
    return 'year';
  }
  return null;
}

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ 17b's PREVIEW - THE EXACT CHARGE, STATED BY THE SERVER (billing 42c52c6e)
 * ════════════════════════════════════════════════════════════════════════════
 * `POST /billing/subscription/change-plan/preview` → `{ ok, preview }`.
 * `chargeNow.gross` is exactly what leaves the card (ILS, VAT included); it is
 * sent back on the change as `expectedChargeAmount`, with `fxRateVersion`, and
 * a change at any other figure is refused (409 charge_amount_changed) rather
 * than charged. `chargeNow` is null for a trial, an equal-price move up, a move
 * down (scheduled, effectiveAt = period end) - and when refused.
 */
const money = z.union([z.string(), z.number()]).transform(String);

export const planChangePreviewSchema = z
  .object({
    preview: z.object({
      applied: z.enum(['immediate', 'scheduled']),
      chargeNow: z
        .object({
          gross: money,
          net: money,
          tax: money,
          taxPercent: money.nullable().catch(null).default(null),
          chargeCurrency: z.string(),
          vatIncluded: z.boolean().catch(true).default(true),
          fxRateVersion: z.number().int().nullable().catch(null).default(null),
        })
        .nullable()
        .default(null),
      refused: z
        .object({ code: z.string(), reason: z.string().nullable().catch(null).default(null) })
        .nullable()
        .catch(null)
        .default(null),
      /** `false`: the change would fail with no_payment_method - add a card first. */
      hasPaymentMethod: z.boolean().nullable().catch(null).default(null),
      effectiveAt: z.string().nullable().catch(null).default(null),
      newMonthly: z
        .object({ amount: money, currency: z.string() })
        .nullable()
        .catch(null)
        .default(null),
    }),
  })
  .transform(({ preview }) => preview);
export type PlanChangePreview = z.infer<typeof planChangePreviewSchema>;

/** What change-plan answers: `{ ok, applied, effectiveAt?, … }`. */
export const planChangeResultSchema = z.object({
  applied: z.enum(['immediate', 'scheduled']),
  effectiveAt: z.string().nullable().catch(null).default(null),
});
