import { z } from 'zod';

/**
 * Topping up, and what happens when you stop — screen 17d.
 *
 * `GET /api/billing/auto-purchase` → `{ policy, currency, paygRate }`. The
 * currency travels with the answer even when no policy row exists, so the
 * screen can name an amount before anything is configured.
 *
 * ── THE PLATFORM HAS MORE TO SAY HERE THAN THE DESIGN DOES ──
 * The design offers *"set a spending cap"*. The model carries **two
 * thresholds and five behaviours**, and each behaviour is a different day for
 * whoever is working:
 *
 *   `STOP_AI`          the AI stops answering. The default.
 *   `HUMAN_ONLY`       the AI stops; people carry on.
 *   `REQUIRE_APPROVAL` the AI keeps going, and every action waits for a person.
 *   `PREPAID_ONLY`     never buy more — run on what was bought in advance.
 *   `PAYG`             keep serving past zero and bill it at the end of the cycle.
 *
 * **These are not five settings of one thing.** `STOP_AI` and `PAYG` are
 * opposite answers to "we ran out": one stops the product, the other keeps
 * spending. A control that presents them as a list of equals is accurate and
 * unhelpful — the screen says what each one does to the people using GOTCHA
 * tomorrow.
 *
 * ── AND THERE ARE TWO THRESHOLDS, NOT ONE ──
 * `warningThresholdPct` (80 by default) tells the owner, and
 * `thresholdPct` (10) triggers the purchase. The design draws a single cap.
 * **A warning that fires at the same moment as the action it warns about is
 * not a warning**, which is presumably why they are separate — and a screen
 * showing only one of them hides the fact that someone is told first.
 */

export const LIMIT_BEHAVIORS = [
  'STOP_AI',
  'HUMAN_ONLY',
  'REQUIRE_APPROVAL',
  'PREPAID_ONLY',
  'PAYG',
] as const;
export type LimitBehavior = (typeof LIMIT_BEHAVIORS)[number];

export const autoPurchaseSchema = z.object({
  enabled: z.boolean().default(false),
  /** Buy more when remaining credit falls to this percentage. */
  thresholdPct: z.number().default(10),
  /** Tell the owner at this percentage — **before** the purchase threshold. */
  warningThresholdPct: z.number().default(80),
  /** Decimal string. Null means no cap has been set. */
  maxMonthlySpend: z.string().nullable().default(null),
  /** Spent so far in the current billing-cycle window. */
  monthSpentAmount: z.string().default('0'),
  limitBehavior: z.enum(LIMIT_BEHAVIORS).catch('STOP_AI'),
  lastTriggeredAt: z.string().nullable().default(null),
});

export type AutoPurchase = z.infer<typeof autoPurchaseSchema>;

export const autoPurchaseResponseSchema = z
  .object({
    policy: z.unknown().nullable().default(null),
    currency: z.string().default('ILS'),
    /** Only meaningful when `limitBehavior` is `PAYG`. */
    paygRate: z.string().nullable().default(null),
  })
  .transform(({ policy, currency, paygRate }) => ({
    /** `null` when nothing has been configured — not a policy of defaults. */
    policy: policy === null ? null : autoPurchaseSchema.parse(policy),
    currency,
    paygRate,
  }));

/**
 * How much of the cap is already spent, as a fraction.
 *
 * `null` when there is no cap — **not zero**. "No limit set" and "nothing
 * spent against the limit" are different facts, and a bar at 0% would state
 * the second about a tenant in the first position.
 */
export function capUsed(policy: AutoPurchase): number | null {
  if (policy.maxMonthlySpend === null) return null;
  const cap = Number.parseFloat(policy.maxMonthlySpend);
  const spent = Number.parseFloat(policy.monthSpentAmount);
  if (!Number.isFinite(cap) || cap <= 0 || !Number.isFinite(spent)) return null;
  return spent / cap;
}

/**
 * Does this behaviour keep spending money after the credit runs out?
 *
 * The one distinction a merchant setting a cap actually needs: `PAYG` serves
 * past zero and bills afterwards, so **a cap plus `PAYG` does not cap the
 * bill.** Every other behaviour stops something instead.
 */
export function spendsPastZero(behavior: LimitBehavior): boolean {
  return behavior === 'PAYG';
}

/** Does the AI keep answering customers once the limit is reached? */
export function aiKeepsAnswering(behavior: LimitBehavior): boolean {
  return behavior === 'REQUIRE_APPROVAL' || behavior === 'PAYG';
}
