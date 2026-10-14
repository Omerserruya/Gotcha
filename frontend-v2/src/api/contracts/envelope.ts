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
   * This was required, and a body without it failed the parse - which
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
  /**
   * A sentence written FOR the merchant - only where a route says so (backend
   * 1aaaefe4: `422 { error: 'validation_failed', message }` from a key form).
   */
  message: z.string().optional(),
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
   * ════════════════════════════════════════════════════════════════════════
   * ★★ THE ENTITLEMENT GATE SENDS `upgradePath`, NOT `checkoutPath`
   * ════════════════════════════════════════════════════════════════════════
   * Two different 402s share this envelope and they do not share field names.
   * The TENANT gate sends `checkoutPath`; `EntitlementDeniedError` - the
   * feature-level refusal in `packages/shared` - sends `upgradePath`, `feature`,
   * `currentPlan`, and `limit`/`current` on a limit breach.
   *
   * None of those were declared, so `z.object` stripped every one of them. The
   * fourth time this week a field on the wire was invisible from inside this
   * codebase, and this one cost the only link that would have told somebody
   * where to go.
   */
  upgradePath: z.string().optional(),
  /** The feature key that was refused, e.g. `ai.copilot`. */
  feature: z.string().optional(),
  /** The plan the tenant is on, or `null` when it has none. */
  currentPlan: z.string().nullable().optional(),
  /** Limit breaches only. */
  limit: z.number().optional(),
  current: z.number().optional(),
  /** A 429's wait in seconds (`REFRESH_RATE_LIMITED`). A bad value is no wait, not an unread error. */
  retryAfterSeconds: z.number().nonnegative().optional().catch(undefined),
  /** A 422's field path, where the route names one (`steps[0].kind`, skills' `INVALID_SKILL`). */
  field: z.string().optional().catch(undefined),
  /**
   * A refusal's own reason, bound and place, where the route names them -
   * an employee's rules' `400 GUARDRAILS_INVALID { reason, max, index }`
   * (Backend c0cd7fbc): which rule, and the limit it broke.
   */
  reason: z.string().optional().catch(undefined),
  max: z.number().optional().catch(undefined),
  index: z.number().int().nonnegative().optional().catch(undefined),
  /**
   * An image refused for its size (W3, conversation 7f9e204f):
   * `IMAGE_TOO_LARGE { maxBytes }`, `IMAGE_DIMENSIONS_TOO_LARGE { maxWidth,
   * maxHeight, width, height }`.
   */
  maxBytes: z.number().optional().catch(undefined),
  maxWidth: z.number().optional().catch(undefined),
  maxHeight: z.number().optional().catch(undefined),
  width: z.number().optional().catch(undefined),
  height: z.number().optional().catch(undefined),
  /**
   * A validator's refusal (`422 { error: 'validation_failed', errors,
   * warnings }` - automations' activate and live save): the issues, read by
   * the screen's own contract. Declared, or `z.object` strips them.
   */
  errors: z.array(z.unknown()).optional().catch(undefined),
  warnings: z.array(z.unknown()).optional().catch(undefined),
  /**
   * The billing services' machine-readable reason, which is **not** `code`.
   *
   * `purchase.service.ts` returns `failureCode` on every refusal -
   * `quantity_exceeds_maximum`, `plan_not_eligible_for_packages`,
   * `package_expired`, and the payment provider's own decline code. The route
   * sends that object as the 402 body verbatim.
   */
  failureCode: z.string().optional(),
  /**
   * Per-code payload for `failureCode`. Its shape depends on the code -
   * `{ max }` for `quantity_exceeds_maximum`, `{ balance, thresholdUnits }`
   * for `no_shortage` - so it is read through a narrow accessor at the point
   * of use and never rendered as it stands.
   */
  /*
   * ★ Some routes send `detail` as a SENTENCE (Shopify's claim: "This
   * workspace is connected to …"). Typed as a record only, a string here
   * failed the whole envelope - `error` and all. Kept as a record when it is
   * one; a string reaches the screen as nothing rather than breaking the rest.
   */
  detail: z.record(z.string(), z.unknown()).optional().catch(undefined),
  /**
   * A refusal's own data, where a route sends one (Shopify's claim 409:
   * `{ currentShopDomain, incomingShopDomain }`). Read through a narrow accessor.
   */
  data: z.record(z.string(), z.unknown()).optional().catch(undefined),
  /**
   * The permission keys a grant would hand out without the caller holding
   * them - a 403 `ABOVE_OWN_ROLE` from role edits, grants, assignments and
   * invites (auth 679b8812, `lib/grant-ceiling`). A sibling of `code`, not
   * inside `data`. A bad value is no list, not an unread error.
   */
  missing: z.array(z.string()).optional().catch(undefined),
  /**
   * The keys a built-in role can never hold that an edit tried to give it - a
   * 403 `ROLE_CEILING` from `PUT /permissions/roles/:id/features` (auth
   * 30d610da). A sibling of `code`, like `missing`; a bad value is no list.
   */
  blocked: z.array(z.string()).optional().catch(undefined),
  /**
   * ★★ PRESENT ON A FAILURE ONLY WHEN THE CARD WAS ACTUALLY REACHED.
   *
   * `buyCredits` sets it solely from `chargeFor`'s result, so on a refusal it
   * is the difference between *"we declined to charge you"* and *"your card
   * was charged and the charge failed"*. It is also the reference a merchant
   * needs when ringing about a payment whose outcome is unknown - which the
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
