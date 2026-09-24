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
 * ELECTING A PART: THE WRITE EXISTS, THE READ DOES NOT
 * ════════════════════════════════════════════════════════════════════════════
 * This block used to say electing was impossible. That was true when it was
 * written and stopped being true when Backend's commit landed:
 * `PUT /business-core/role` writes `config.roles`, displaces what held the
 * part, and refuses the CRM with `CRM_ELECTED_ELSEWHERE`.
 *
 * ★ BUT "SAVED" IS NARROWER THAN IT SOUNDS, AND THE SCREEN SAYS SO.
 * `config.roles` is read in exactly ONE place in the monorepo —
 * `business-roles.ts:188-195`, the displacement logic inside that same write.
 * **Nothing in the AI's decision path reads it.** So an election is stored,
 * real, and changes no behaviour until Backend's read path lands.
 *
 * The earlier fear — four controls that look right, respond to clicks and
 * change nothing — is met by saying it rather than by withholding the
 * control: `core-elect-not-wired` carries the claim, and the e2e assertion
 * on it fails the day it stops being true, which is what makes its removal a
 * deliberate act rather than a caveat nobody revisits.
 */

export const USE_CASES = ['ecommerce', 'leads', 'both'] as const;
export type UseCase = (typeof USE_CASES)[number];

export const BUSINESS_ROLES = ['ecommerce', 'payments', 'shipping', 'returns', 'crm'] as const;

/**
 * Why a part resolves to the system it does — the platform's `PartSource`.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★ THIS LIST SHIPPED WITH THREE OF ITS FOUR MEMBERS AND TOOK THE SCREEN DOWN
 * ════════════════════════════════════════════════════════════════════════════
 * `shipping` resolves to `unavailable`, which was missing here. Zod's
 * `.default()` does NOT rescue that: a default applies to an ABSENT key, and
 * this key arrives present with a value outside the enum — so the parse
 * fails, `loadBusinessCore` returns null, and **every part disappears,
 * including the four that were fine.** One bad member rejects the whole
 * response. The server answered 200 with a valid body.
 *
 * ── HOW THE FOURTH WAS MISSED, WHICH IS THE PART WORTH KEEPING ──
 * I read the producer by grepping for occurrences instead of reading the
 * type. Neither obvious pattern finds all four:
 *
 *   grep 'source: "…"'   misses `inferred` — it comes from a ternary
 *   grep at the resolver misses `unavailable` — it is returned by the
 *                        availability guard ABOVE the resolution logic
 *
 * And when I did open the declaration, I printed six lines of a nine-line
 * union and took it for the whole thing. The authority for a union's DOMAIN
 * is the type, read to its end — never the call sites, and never a window
 * over the type.
 *
 * ── AND THIS IS THE SCHEMA-BOUNDARY RULE IN ITS LOUD DIRECTION ──
 * A field we do not name is stripped silently; a field we DO name breaks the
 * whole response when our idea of its domain is wrong. Naming a field is not
 * the end of the work — naming its domain is. 903 unit tests passed
 * throughout, because the fixtures carried the three values I knew about: a
 * contract test is only as complete as the author's model of the producer.
 */
export const PART_SOURCES = ['elected', 'inferred', 'unmapped', 'unavailable'] as const;
export type PartSource = (typeof PART_SOURCES)[number];
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
  /**
   * ⚠ TWO DIFFERENT FACTS ARRIVE UNDER THIS ONE KEY, AND THE SECOND WINS.
   *
   * `roleAvailability()` returns `{ available: false, reason:
   * "no_integrations_exist" }` — an ENUM. The route spreads that and then
   * writes `reason: resolved.reason` after it, so the resolver's free text
   * ("No system has been chosen for payments.") overwrites the enum for
   * every part, including the unavailable ones.
   *
   * Nothing here reads it, so nothing broke — `partState()` keys on
   * `available`, not on this. But the availability enum is no longer
   * retrievable from the response, and a later screen that trusts the
   * documented meaning would get prose where it expected a code. Reported;
   * typed as the string it actually is rather than the enum it is
   * documented as.
   */
  reason: z.string().nullable().default(null),
  /**
   * The unavailability CODE, added at 61f0792f after the collision above was
   * reported. `reason` keeps the prose; this keeps the enum.
   *
   * ★ PRESENT ONLY ON AN UNAVAILABLE PART, AND THAT ASYMMETRY IS DELIBERATE.
   * Backend's tidy instinct was `unavailableReason: null` on every part.
   * They rejected it for our scar: a strict `z.object` strips an unexpected
   * key harmlessly but refuses a CHANGED TYPE, which is how the whole voice
   * screen vanished behind "could not be loaded" when `messagesAnalysed`
   * went 0 → null. A part that CAN be offered has no unavailability reason,
   * and a null one would be a value where absence is the fact — the same
   * distinction as `available: false` versus an empty array.
   *
   * Optional here rather than nullable, to match: `.optional()` accepts the
   * key being missing, which is what an available part actually sends.
   *
   * Today's only value is `no_integrations_exist`. Nothing reads it yet —
   * `partState()` keys on `available` and the sentence comes from `detail` —
   * so this is recorded rather than rendered.
   */
  unavailableReason: z.string().optional(),
  /** Who serves it today. Null when nobody does. */
  elected: z.object({ slug: z.string(), name: z.string() }).nullable().default(null),
  /**
   * ★ WHY IT IS THAT SYSTEM — AND "INFERRED" IS NOT A DECISION.
   *
   * `elected` alone cannot tell them apart. `returns` resolves to Shopify
   * because the capability resolver found it could serve returns, NOT
   * because a merchant said so; the prompt the model receives spells this
   * out — "shopify (inferred, not chosen by the business)".
   *
   * Rendering that as a selected option would invent consent: the screen
   * would show a choice nobody made, and the next person to open it would
   * believe they or a colleague had made it.
   *
   * The route has served this since 2d1abf88. Our schema is `object`, not
   * `looseObject`, so until now it was stripped at the boundary and the UI
   * could not have drawn the distinction even in principle.
   */
  source: z.enum(PART_SOURCES).default('unmapped'),
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
 * The parts whose elector lives somewhere else, and WHERE.
 *
 * Backend's design is a facade: a part's storage is wherever its consumer
 * already looks. The CRM has `config.useAsCrm`; returns has
 * `config.returnProvider`, an explicit switch whose own header says
 * "explicit selection wins over inference". `config.roles` carries only the
 * parts that had no elector — ecommerce and payments.
 *
 * So `PUT /business-core/role` refuses both, with a code each, and the
 * screen must point at two DIFFERENT places. One sentence for both would
 * send somebody to the wrong screen half the time.
 */
export const ELECTED_ELSEWHERE: Partial<Record<BusinessRole, 'crm' | 'returns'>> = {
  crm: 'crm',
  returns: 'returns',
};

export type ElectedElsewhere = 'crm' | 'returns';

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
  if (ELECTED_ELSEWHERE[part.role] || !part.available) return false;
  return part.candidates.some((c) => c.connected);
}

/**
 * The CRM is chosen somewhere else, and the screen has to say where.
 *
 * Omitting it would leave the one part a merchant cannot configure here
 * looking identical to the four they can.
 */
export function electedElsewhere(part: RolePart): ElectedElsewhere | null {
  return ELECTED_ELSEWHERE[part.role] ?? null;
}

/**
 * ★ AND "INFERRED" IS NOT "CHOSEN".
 *
 * `returns` resolves to Shopify because a capability resolver found it could
 * serve returns. No merchant said so. A control showing it as the selected
 * option would be representing something it did not capture — the same
 * refusal as the wildcard roles, where a grid that cannot express `*:*` must
 * not flatten it into a set of ticks nobody chose.
 */
export function isInferred(part: RolePart): boolean {
  return part.source === 'inferred' && part.elected !== null;
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
