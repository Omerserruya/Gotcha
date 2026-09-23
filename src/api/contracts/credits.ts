import { z } from 'zod';

/**
 * Credits — screen 17c.
 *
 * `GET /api/billing/credit-summary`.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE DESIGN SHOWS ONE NUMBER AND A BAR. NEITHER SURVIVES CONTACT.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── 1. THE BALANCE IS TWO BUCKETS THAT EXPIRE OPPOSITELY ──
 * The schema on `ai_unit_lots`:
 *
 * > *"Two buckets: INCLUDED (monthly, **expires at renewal**) and PURCHASED
 * > (**never expires**, FIFO)."*
 *
 * `deriveBalanceFromLots` enforces half of it structurally — an INCLUDED lot
 * counts only while `lot.periodKey === currentPeriodKey`. A tenant with 900
 * included and 300 purchased has 1,200 today and 300 on renewal day. A single
 * total is arithmetically correct and answers none of the question that makes
 * somebody open this screen.
 *
 * The other half of that comment is a DEFAULT, not a rule: purchased credits
 * can be sold to expire — see {@link purchasedBalance}. So this screen names
 * what the plan bucket does and declines to promise anything about the rest.
 *
 * ── 2. "CONSUMED" IS A SUBTRACTION, NOT A MEASUREMENT ──
 * `credits.ts:65`:
 *
 * ```ts
 * const consumedCredits = Math.max(0, balance.includedAllowance - balance.includedRemaining);
 * ```
 *
 * **Anything that removes credits without spending them lands in that figure**,
 * and expiry removes credits without spending them. Measured on this tenant:
 *
 * | ledger entry | when | units |
 * |---|---|---|
 * | `GRANT`   | 2026-07-28 | +7,000.00 |
 * | `CONSUME` (1,077 rows) | 2026-07-28 → 2026-08-07 | −340.01 |
 * | `EXPIRE`  | 2026-08-28 | −6,659.99 |
 *
 * The snapshot `tenant_ai_balances` therefore holds `includedAllowance 7000`,
 * `includedRemaining 0` — and the route reports **`consumedCredits: 7000`,
 * `consumedPct: 100`**. The truth is that 340 were used and 6,660 lapsed
 * unused: **5% consumption rendered as 100%**.
 *
 * A usage bar at 100% tells an owner their AI burned the year's allowance in
 * ten days. It is the same error this project keeps finding, committed one
 * layer down: *a figure complete with respect to its formula, presented as a
 * fact about the world.*
 *
 * **So this screen does not draw the bar.** `consumedCredits` and
 * `consumedPct` are parsed and deliberately left unrendered until the route
 * separates spend from expiry — see {@link consumptionIsTrustworthy}, which
 * detects the specific contradiction rather than assuming it.
 *
 * ── 3. AND THE CURRENT PERIOD HAS NO GRANT AT ALL ──
 * The subscription is `ai_voice`, ACTIVE, `2026-09-08 → 2027-09-08`,
 * contracted for 7,000. The balance snapshot's `periodKey` is **`2026-07`**,
 * last written 2026-08-28. One lot has ever existed and it expired.
 *
 * So `includedCredits: 7000` is the **contract**, not a grant — the route says
 * as much at `:59`, *"the CONTRACTED allowance, from the subscription's own
 * snapshot"*. Saying "7,000 included" beside "0 remaining" without saying
 * which is promised and which is held would read as a loss.
 *
 * ── 4. TWO ESTIMATES, AND THEY MAY NOT BE SWAPPED ──
 * `estimatedRemaining` uses the **public commercial ratio** — what the plan
 * promises. `observedRemaining` uses **this tenant's own measured burn**. The
 * route is emphatic that both ship, *"each labelled with its basis"*, because
 * *"a screen that silently swapped them would make a pricing claim out of one
 * customer's behaviour"*. So the screen names which one it is showing.
 *
 * ── 5. `no_consumption_recorded` IS NOT "YOU HAVEN'T USED ANYTHING" ──
 * This tenant had **88 conversations** in the trailing 30-day window and
 * **zero** CONSUME entries in it. `observedConversationCost` tests
 * `creditsConsumed <= 0` *before* the sample-size gate, so it returns
 * `no_consumption_recorded` with `sample.conversations: 88`.
 *
 * The reason code is about **metering**, not about activity, and the sample
 * beside it proves the difference. Rendering it as "no activity" would be a
 * plain falsehood sitting next to the 88 that contradicts it.
 * ════════════════════════════════════════════════════════════════════════════
 */

/** Why the tenant's own burn rate could not be measured. */
export const OBSERVED_REASONS = ['not_enough_conversations', 'no_consumption_recorded'] as const;
export type ObservedReason = (typeof OBSERVED_REASONS)[number];

/** `MIN_SAMPLE_CONVERSATIONS` in `observed-usage.service.ts`. */
export const MIN_SAMPLE_CONVERSATIONS = 20;
/** `OBSERVED_WINDOW_DAYS` in the same file. */
export const OBSERVED_WINDOW_DAYS = 30;

const estimateSchema = z.object({
  chats: z.number().nullable().default(null),
  calls: z.number().nullable().default(null),
});

export const creditSummarySchema = z.object({
  period: z
    .object({
      startsAt: z.string().nullable().default(null),
      endsAt: z.string().nullable().default(null),
      resetsAt: z.string().nullable().default(null),
    })
    .default({ startsAt: null, endsAt: null, resetsAt: null }),
  plan: z
    .object({
      name: z.string().nullable().default(null),
      /** CONTRACTED, from the subscription snapshot — not a grant. */
      includedCredits: z.number().default(0),
    })
    .default({ name: null, includedCredits: 0 }),
  usage: z
    .object({
      /** Allowance minus remaining. Expiry lands here too — see the header. */
      consumedCredits: z.number().default(0),
      /** The INCLUDED bucket — the half that lapses at renewal. */
      remainingPlanCredits: z.number().default(0),
      consumedPct: z.number().default(0),
    })
    .default({ consumedCredits: 0, remainingPlanCredits: 0, consumedPct: 0 }),
  /** The PURCHASED bucket — never expires, FIFO. */
  purchasedCredits: z.object({ balance: z.number().default(0) }).default({ balance: 0 }),
  totalAvailableCredits: z.number().default(0),
  creditSources: z
    .object({
      plan: z.number().default(0),
      purchased: z.number().default(0),
      promotional: z.number().default(0),
      trialOrPoc: z.number().default(0),
    })
    .default({ plan: 0, purchased: 0, promotional: 0, trialOrPoc: 0 }),
  /** What the PLAN promises the balance buys. */
  estimatedRemaining: estimateSchema.default({ chats: null, calls: null }),
  /** What THIS TENANT's measured burn says it buys. Never a substitute. */
  observedRemaining: z
    .object({
      chats: z.number().nullable().default(null),
      basis: z.literal('TENANT_ACTUAL').nullable().default(null),
      creditsPerConversation: z.number().nullable().default(null),
      reason: z.enum(OBSERVED_REASONS).nullable().default(null),
      sample: z
        .object({
          conversations: z.number().default(0),
          creditsConsumed: z.number().default(0),
          /**
           * Share of burn whose ledger entry names a conversation. Low means a
           * per-conversation figure describes less of the bill than it looks.
           */
          conversationAttributedPct: z.number().default(0),
        })
        .default({ conversations: 0, creditsConsumed: 0, conversationAttributedPct: 0 }),
    })
    .default({
      chats: null,
      basis: null,
      reason: null,
      creditsPerConversation: null,
      sample: { conversations: 0, creditsConsumed: 0, conversationAttributedPct: 0 },
    }),
  /**
   * The platform's own wording, shipped per locale.
   *
   * Rendered instead of a string from our catalogue: this exact sentence is
   * what the pricing pages show (`public-pricing.ts:321`, `pricing.ts:71`),
   * and a second translation of it here would drift from the commercial copy
   * without anything failing.
   */
  disclaimer: z
    .object({ en: z.string().default(''), he: z.string().default('') })
    .nullable()
    .default(null),
});

export type CreditSummary = z.infer<typeof creditSummarySchema>;

/** How much of the balance lapses at renewal. */
export function expiringAtRenewal(summary: CreditSummary): number {
  return summary.usage.remainingPlanCredits;
}

/**
 * The PURCHASED balance — which this screen does NOT call permanent.
 *
 * The `ai_unit_lots` comment says *"PURCHASED (never expires, FIFO)"* and
 * that is the **default**, not an invariant. `CreditExpiryPolicy` has three
 * values, and `purchase.service.ts:87-90` honours all of them:
 *
 * | policy | effect on a purchased lot |
 * |---|---|
 * | `NEVER` | persists until consumed |
 * | `DAYS_AFTER_PURCHASE` | expires `expiryDays` after the grant |
 * | `PERIOD_END` | **expires with the billing period, exactly like INCLUDED** |
 *
 * All four packages on sale today are `NEVER`, so purchased credits do not
 * currently expire. That is a fact about the catalogue rows, not about the
 * product, and it can change without any code changing.
 *
 * The credit-summary response cannot settle it either way: the route selects
 * `expiresAt` from the lots and uses only `grantType`, so per-lot expiry never
 * reaches the wire. **So the screen says what expires — the plan bucket, which
 * `deriveBalanceFromLots` gates on `periodKey` structurally — and says nothing
 * about the purchased bucket lasting forever.** The expiry a buyer needs is on
 * the package itself, where `/billing/pricing/packages` does carry it.
 */
export function purchasedBalance(summary: CreditSummary): number {
  return summary.purchasedCredits.balance;
}

/**
 * Does a grant exist for the period the subscription is currently in?
 *
 * The contracted allowance is positive and nothing is held, against a period
 * that has started. Distinguishes *"you spent it"* from *"it was never
 * issued"* — which for this tenant is the difference between an owner
 * believing their AI is expensive and their credits not having been granted.
 */
export function awaitingGrant(summary: CreditSummary): boolean {
  return (
    summary.plan.includedCredits > 0 &&
    summary.totalAvailableCredits === 0 &&
    summary.usage.remainingPlanCredits === 0
  );
}

/**
 * Can the consumption figure be read as usage?
 *
 * **No**, whenever the route claims consumption that the trailing window
 * cannot account for while that window covers the period. `consumedCredits`
 * counts expiry as spend, and this is the contradiction it leaves on the wire:
 * credits consumed in a period that began inside the observed window, with
 * zero credits metered in that window.
 *
 * Deliberately narrow. It reports untrustworthy only on evidence carried in
 * the response itself, so it stops reporting it the moment the route starts
 * separating spend from expiry — rather than suppressing the bar forever.
 */
export function consumptionIsTrustworthy(summary: CreditSummary, now: Date): boolean {
  if (summary.usage.consumedCredits <= 0) return true;
  if (summary.observedRemaining.sample.creditsConsumed > 0) return true;

  const startsAt = summary.period.startsAt ? Date.parse(summary.period.startsAt) : NaN;
  if (Number.isNaN(startsAt)) return true;

  const windowOpened = now.getTime() - OBSERVED_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  // The period began after the window opened, so everything spent in it was
  // measurable — and nothing was measured. The consumption is not spend.
  return startsAt < windowOpened;
}

/**
 * The sentence `no_consumption_recorded` actually supports.
 *
 * `true` when conversations happened and no credits were metered against
 * them: a statement about metering, never about activity.
 */
export function ranWithoutMetering(summary: CreditSummary): boolean {
  const { reason, sample } = summary.observedRemaining;
  return reason === 'no_consumption_recorded' && sample.conversations > 0;
}
