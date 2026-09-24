import { z } from 'zod';

/**
 * Business core — screens 14b and 14c.
 *
 * `GET /api/integrations/business-core`.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE SCREEN THE PLATFORM ACTUALLY PRODUCES IS NEARLY EMPTY
 * ════════════════════════════════════════════════════════════════════════════
 * The design draws the filled-in end state: five parts, five dropdowns, a
 * system chosen for each. Measured on this estate, the first encounter is:
 *
 *   shipping   `available: false` — the category has ZERO integrations and
 *              always will, so its list is empty for every tenant forever
 *   payments   nothing connected
 *   returns    nothing connected
 *   crm        nothing connected
 *   ecommerce  one candidate, Shopify, whose connection is in ERROR
 *
 * So this is a screen that routes somebody to the marketplace and back, not
 * one that fills in five dropdowns. Building for the end state gives a screen
 * that is beautiful once and useless on day one.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * AND ELECTING A PART IS NOT YET POSSIBLE
 * ════════════════════════════════════════════════════════════════════════════
 * `PUT /business-core/use-case` exists. `PUT /:slug/crm-source` elects the
 * CRM. **Nothing writes `config.roles`** — verified repo-wide by both of us —
 * so no other part can be elected at all.
 *
 * A dropdown that saved for one part and silently did nothing for the other
 * four is the mostly-correct display: four controls that look right, respond
 * to clicks and change nothing, which nobody would find by looking. So 14c
 * ships as a READ, and says so.
 */

export const USE_CASES = ['ecommerce', 'leads', 'both'] as const;
export type UseCase = (typeof USE_CASES)[number];

export const BUSINESS_ROLES = ['ecommerce', 'payments', 'shipping', 'returns', 'crm'] as const;
export type BusinessRole = (typeof BUSINESS_ROLES)[number];

export const candidateSystemSchema = z.object({
  slug: z.string(),
  name: z.string(),
  /**
   * STATUS, not presence. A `TenantIntegration` row exists for anything a
   * tenant ever started connecting, including one sitting in ERROR.
   *
   * Backend found this live: the read reported Shopify as connected because a
   * row existed, while the election endpoint refused it for not being
   * `CONNECTED` — the screen offering a system as ready that the write would
   * reject, with nothing to tell the merchant why.
   */
  connected: z.boolean().default(false),
  /**
   * `null` = never connected. Any other value = a row exists and is not
   * usable yet, which needs a different sentence from "not connected".
   *
   * Three states, and our own tenant is the middle one: Shopify in ERROR.
   */
  status: z.string().nullable().default(null),
});

export const rolePartSchema = z.object({
  role: z.enum(BUSINESS_ROLES),
  /**
   * `false` when NOTHING could ever serve this part.
   *
   * Distinct from an empty `candidates` array, which means "nothing connected
   * yet". Backend refused to collapse them, and the reason is the one this
   * project keeps meeting: *"'nothing exists to choose' and 'nothing
   * connected yet' need different sentences and an empty list reads as the
   * second."*
   */
  available: z.boolean().default(true),
  reason: z.string().nullable().default(null),
  /** Who serves it today. Null when nobody does. */
  elected: z.object({ slug: z.string(), name: z.string() }).nullable().default(null),
  candidates: z.array(candidateSystemSchema).default([]),
});

export type RolePart = z.infer<typeof rolePartSchema>;

export const businessCoreSchema = z.object({
  /** Null until somebody chooses. The choice decides which parts are asked about. */
  useCase: z.enum(USE_CASES).nullable().default(null),
  roles: z.array(rolePartSchema).default([]),
  /**
   * Two facts the catalogue cannot express, written by the platform so each
   * client does not rediscover them. Rendered verbatim.
   */
  catalogueNotes: z.array(z.string()).default([]),
});

export type BusinessCore = z.infer<typeof businessCoreSchema>;

/* ── What a part can say about itself ────────────────────────────────────── */

export type PartState =
  /** Nothing could ever serve it. Not the tenant's doing. */
  | 'impossible'
  /** Something could, and nothing is connected. Go to the marketplace. */
  | 'nothing_connected'
  /**
   * Something was connected and is not working. The merchant has already done
   * the work, so "connect it" is the wrong instruction — "fix it" is.
   */
  | 'connected_but_failing'
  /** Something is connected and nothing is chosen. */
  | 'connected_none_chosen'
  /** A system serves it today. */
  | 'chosen';

export function partState(part: RolePart): PartState {
  if (!part.available) return 'impossible';
  if (part.elected) return 'chosen';
  if (part.candidates.some((c) => c.connected)) return 'connected_none_chosen';
  // Checked AFTER connected, so one healthy system is not hidden by one
  // broken one. Only when nothing usable is behind the part does the failure
  // become the thing to say.
  if (part.candidates.some((c) => connectedButFailing(c))) return 'connected_but_failing';
  return 'nothing_connected';
}

/**
 * Can this part be elected through `PUT /business-core/role`?
 *
 * ★ EVERY PART EXCEPT THE CRM. I had this exactly inverted before reading
 * Backend's commit: I assumed the CRM was the only electable one because it
 * was the only one with a writer. It is the one the endpoint REFUSES —
 * `config.useAsCrm` and its resolver already elect the customer system of
 * record, and a second path would be two sources for one decision.
 *
 * The refusal carries `CRM_ELECTED_ELSEWHERE` and points at the one path,
 * rather than failing silently.
 *
 * A part must also be possible and have something CONNECTED behind it: the
 * write refuses an election for a system that is not connected, so offering
 * one would be offering a control the server rejects.
 */
export function electable(part: RolePart): boolean {
  if (part.role === 'crm' || !part.available) return false;
  return part.candidates.some((c) => c.connected);
}

/**
 * The CRM is chosen somewhere else, and the screen has to say where.
 *
 * Omitting it would leave the one part a merchant cannot configure here
 * looking identical to the four they can.
 */
export function electedElsewhere(part: RolePart): boolean {
  return part.role === 'crm';
}

/**
 * A system that has been connected and is not usable.
 *
 * Distinct from never-connected in the direction that matters: the merchant
 * has already done the work and something is wrong with it, so "connect it"
 * is the wrong instruction.
 */
export function connectedButFailing(candidate: {
  connected: boolean;
  status: string | null;
}): boolean {
  return !candidate.connected && candidate.status !== null;
}

/** Parts worth sending somebody to the marketplace for. */
export function needsMarketplace(core: BusinessCore): readonly RolePart[] {
  return core.roles.filter((p) => partState(p) === 'nothing_connected');
}

/**
 * What an election displaced, so the screen can say "it was WooCommerce".
 *
 * The write DISPLACES rather than refusing when a part is taken — refusing
 * recreates the undeletable-employee trap, where a merchant is blocked by a
 * state they cannot see and did not set. Silent displacement is the
 * reassuring direction, so it succeeds and names what it replaced.
 */
export const electionResultSchema = z.object({
  replaced: z.object({ slug: z.string(), name: z.string() }).nullable().default(null),
});

export type ElectionResult = z.infer<typeof electionResultSchema>;
