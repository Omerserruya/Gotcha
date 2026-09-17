import { z } from 'zod';

/**
 * Settings · Usage & billing — screen 17.
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
 *     the AI-Units auto-purchase ceiling — a different resource with different
 *     consequences — and presenting it as a spending cap would be this
 *     screen's version of the per-person money limits.
 */

/**
 * `GET /api/usage/allowance` — enveloped in `data`.
 *
 * **The projection is computed server-side and must not be re-derived here.**
 * The route's own comment gives the reason: *"A client working out its own
 * run-rate would put a different date on Home than the one billing acts on,
 * and the first time those disagree is the last time anyone believes either."*
 * Home already draws from this; the two surfaces must agree because they read
 * the same answer, not because they run the same formula.
 *
 * Path taken from the mount (`usage-allowance.ts:30`), not from the filename —
 * this is one of the three routes in the platform that split a compound name
 * with a slash rather than a hyphen.
 */
export const allowanceSchema = z.object({
  /** Conversations counted in this period, excluding test conversations. */
  used: z.number().default(0),
  /**
   * `null` when the plan carries no conversation allowance — which is the case
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
 * charged — the demo tenant is `$1,499.00 USD`. The screen renders that
 * currency and does not convert: a symbol the row does not carry is a number
 * nobody agreed to.
 */
export const subscriptionSchema = z.object({
  planKey: z.string(),
  status: z.string(),
  snapshotPrice: z.union([z.string(), z.number()]).nullable().optional(),
  snapshotCurrency: z.string().nullable().optional(),
  currentPeriodEnd: z.string().nullable().optional(),
  cancelAtPeriodEnd: z.boolean().default(false),
  billingInterval: z.string().nullable().optional(),
  /** A plan change already scheduled for renewal, so the screen can say so. */
  pendingChange: z
    .object({ targetPlanKey: z.string().nullable().optional() })
    .nullable()
    .optional(),
});

export const subscriptionResponseSchema = z.object({
  subscription: subscriptionSchema.nullable().default(null),
});

export type Subscription = z.infer<typeof subscriptionSchema>;

/**
 * An invoice — **contracted, not yet served.**
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

/** `PaymentMethod` — `brand` and `last4` give the design's "Visa · 4417". */
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
 * *"Where the month went"* — **contracted, not yet served.**
 *
 * Every piece exists separately: `Conversation.handledBy` gives the AI/human
 * split, `Broadcast`/`BroadcastRecipient` the outbound count, and
 * `VoiceCallSession` the minutes — with `Subscription.voiceVolumeOptionKey`
 * showing minutes are metered with an allowance of their own. Nothing
 * aggregates them.
 *
 * A separate read from the billing summary deliberately: the two change on
 * completely different cadences, and a failure in one must not blank the
 * other.
 */
export const usageBreakdownSchema = z.object({
  handledByAi: z.number().nullable().default(null),
  handledByPeople: z.number().nullable().default(null),
  outboundMessages: z.number().nullable().default(null),
  voiceMinutes: z.number().nullable().default(null),
  /** `null` when the plan carries no voice allowance, exactly like `limit`. */
  voiceMinutesLimit: z.number().nullable().default(null),
});

export type UsageBreakdown = z.infer<typeof usageBreakdownSchema>;
