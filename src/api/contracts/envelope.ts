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
  error: z.string(),
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
