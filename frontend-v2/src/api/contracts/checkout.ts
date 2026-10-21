import { z } from 'zod';

/**
 * The customer checkout - billing's `routes/checkout.ts` (read) and
 * `routes/checkout-session.ts` (the two writes and the welcome email).
 *
 * Who may ask: the emailed continuation token (`?token=` on a read, `{ token }`
 * in a write's body), OR a session whose user belongs to the checkout's
 * tenant, OR platform admin (`lib/checkout-auth.ts`). Anything else is the
 * same 404 as a reference that does not exist - by design.
 */

/**
 * The customer-facing status (`checkout.ts:52` `SafeStatus`), never the raw
 * row state. Required: it decides which page the checkout belongs on, and a
 * summary without it has nothing to say.
 */
export const CHECKOUT_STATUSES = [
  'AWAITING_PAYMENT_SETUP',
  'PROCESSING',
  'PAYMENT_REQUIRED',
  'FAILED',
  'EXPIRED',
  'COMPLETED',
  'MANUAL_REVIEW',
] as const;
export type CheckoutStatus = (typeof CHECKOUT_STATUSES)[number];

/** `lib/decline-category.ts:13` - a category, never the provider's string. */
export const DECLINE_CATEGORIES = [
  'CARD_EXPIRED',
  'INSUFFICIENT_FUNDS',
  'CARD_UNUSABLE',
  'DECLINED',
] as const;
export type DeclineCategory = (typeof DECLINE_CATEGORIES)[number];

/** What the card is debited (ILS), and whether that figure is frozen. */
const chargeSchema = z.object({
  amount: z.string(),
  currency: z.string(),
  exchangeRate: z.string(),
  /** True once a real charge froze these numbers; false while indicative. */
  settled: z.boolean().catch(false).default(false),
});

/** `GET /api/checkout/{reference}/status` - enveloped in `data` (`checkout.ts:259`). */
export const checkoutSummarySchema = z.object({
  reference: z.string(),
  status: z.enum(CHECKOUT_STATUSES),
  organizationName: z.string().nullable().catch(null).default(null),
  planName: z.string().catch('').default(''),
  includedCredits: z.number().catch(0).default(0),
  /** The agreed price, as a decimal string. */
  amount: z.string().catch('').default(''),
  currency: z.string().catch('').default(''),
  /** `null` when no rate is approved: then payment cannot be offered. */
  charge: chargeSchema.nullable().catch(null).default(null),
  billingInterval: z.string().catch('MONTHLY').default('MONTHLY'),
  expiresAt: z.string().nullable().catch(null).default(null),
  /** Retry is offered only where it cannot double-charge (`checkout.ts:278`). */
  retryEligible: z.boolean().catch(false).default(false),
  /** A provider that can store a card AND an approved rate (`checkout.ts:294`). */
  paymentSetupAvailable: z.boolean().catch(false).default(false),
  declineCategory: z.enum(DECLINE_CATEGORIES).nullable().catch('DECLINED').default(null),
  /**
   * The outcome is unknown, not merely in flight: resolving it needs a
   * provider lookup and possibly a person, so nobody is promised "a moment".
   */
  awaitingResolution: z.boolean().catch(false).default(false),
});
export type CheckoutSummary = z.infer<typeof checkoutSummarySchema>;

/** `POST /api/checkout/{reference}/payment-session` → `{ data: { redirectUrl } }`. */
export const paymentSessionSchema = z.object({ redirectUrl: z.string().url() });

/** `POST /api/checkout/{reference}/advance` → `{ data: { phase, declineCategory? } }`. */
export const advanceSchema = z.looseObject({ phase: z.string() });

/** `POST /api/checkout/{reference}/resend-welcome` → `{ data: { sent } }`. */
export const resendWelcomeSchema = z.object({ sent: z.boolean().catch(false).default(false) });
