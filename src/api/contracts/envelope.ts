import { z } from 'zod';

/**
 * The platform's response envelope.
 *
 * Every handler answers `{ "data": ... }` on success and
 * `{ "error": "...", "details": [...] }` on failure. The OpenAPI document is
 * explicit that `data` is untyped - the backend declares no response schemas
 * anywhere - so the shape of `data` is knowable only per endpoint.
 *
 * This is the single place that knowledge lives. Feature code never sees the
 * envelope: it receives the already-unwrapped, already-validated payload.
 */
export const errorEnvelopeSchema = z.object({
  /**
   * ★★ OPTIONAL, BECAUSE A REFUSAL DOES NOT ALWAYS CARRY ONE.
   *
   * This was required, and a body without it failed the parse — which
   * `readErrorBody` turns into `{}`, so **every field was lost, not just this
   * one**. `POST /billing/credits/buy` refuses with
   * `{ success: false, failureCode, detail }` and no `error` key at all, so
   * the reason a purchase was refused never reached the screen: it arrived,
   * parsed to nothing, and rendered as a generic failure on the one screen
   * that charges a card.
   *
   * A required field in an error envelope is a bet that every handler
   * remembered to send it. Losing the bet costs the whole envelope.
   */
  error: z.string().optional(),
  details: z.array(z.object({ field: z.string(), message: z.string() })).optional(),
  /**
   * The commercial gate (402) adds these. `z.object` strips unknown keys, so
   * without declaring them the reason a tenant is locked out is thrown away
   * and the product can only render a blank screen.
   */
  code: z.string().optional(),
  tenantStatus: z.string().optional(),
  /** Where the user must go to lift the block, when there is such a place. */
  checkoutPath: z.string().optional(),
  /**
   * The billing services' machine-readable reason, which is **not** `code`.
   *
   * `purchase.service.ts` returns `failureCode` on every refusal —
   * `quantity_exceeds_maximum`, `plan_not_eligible_for_packages`,
   * `package_expired`, and the payment provider's own decline code. The route
   * sends that object as the 402 body verbatim.
   */
  failureCode: z.string().optional(),
  /**
   * Per-code payload for `failureCode`. Its shape depends on the code —
   * `{ max }` for `quantity_exceeds_maximum`, `{ balance, thresholdUnits }`
   * for `no_shortage` — so it is read through a narrow accessor at the point
   * of use and never rendered as it stands.
   */
  detail: z.record(z.string(), z.unknown()).optional(),
  /**
   * ★★ PRESENT ON A FAILURE ONLY WHEN THE CARD WAS ACTUALLY REACHED.
   *
   * `buyCredits` sets it solely from `chargeFor`'s result, so on a refusal it
   * is the difference between *"we declined to charge you"* and *"your card
   * was charged and the charge failed"*. It is also the reference a merchant
   * needs when ringing about a payment whose outcome is unknown — which the
   * screen previously could not give them, because this field was stripped.
   */
  invoiceId: z.string().nullish(),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

/** Wraps a payload schema in the platform's success envelope. */
export function successEnvelope<T extends z.ZodType>(data: T) {
  return z.object({ data });
}

/**
 * Escape hatch for endpoints whose payload has not been characterised yet.
 *
 * Using this is a deliberate, greppable admission that a contract is missing.
 * It must not become the default: an endpoint that ships to a product page
 * gets a real schema, or it gets an API Gap Report.
 */
export const unknownPayload = z.unknown();
