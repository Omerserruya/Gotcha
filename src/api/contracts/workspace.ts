import { z } from 'zod';

/**
 * Settings · Workspace — screen 11.
 *
 * Shapes read from `services/auth/src/routes/workspace.ts` in full, not from
 * the OpenAPI document: the generator cannot extract response schemas, and an
 * absent schema there means "not extractable", never "returns nothing".
 *
 * These are *"the facts every AI employee quotes to a customer"*, so a field
 * that is absent must render as absent. A workspace that has not filled in its
 * address and one whose address failed to load look identical if either is
 * coerced to an empty string, and only one of them is safe to leave alone.
 */

/** A single day. `open`/`close` are absent on a closed day, not empty. */
export const dayScheduleSchema = z.looseObject({
  enabled: z.boolean().default(false),
  open: z.string().optional(),
  close: z.string().optional(),
});

export const DAY_KEYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

export type DayKey = (typeof DAY_KEYS)[number];

/**
 * Opening hours.
 *
 * `aiOutsideHours` is not cosmetic: `active` means the AI keeps answering
 * while the business is closed, `silent` means it does not. The screen shows
 * the week, but this decides what a customer gets at 23:00.
 */
export const businessHoursSchema = z.looseObject({
  enabled: z.boolean().default(false),
  schedule: z.record(z.string(), dayScheduleSchema).nullable().optional(),
  aiOutsideHours: z.enum(['active', 'silent']).catch('active'),
  outsideHoursHandoffMessage: z.string().default(''),
});

export const workspaceSchema = z.looseObject({
  /** Falls back to the tenant name server-side, so this is never blank. */
  name: z.string().nullable().optional(),
  /** The design's "What you sell". `BusinessProfile.businessDescription`. */
  description: z.string().nullable().optional(),
  websiteDomain: z.string().nullable().optional(),
  industry: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  /**
   * A list by contract, even though storage holds one.
   *
   * PATCH used to accept up to six and keep `languages[0]`, so a caller adding
   * English beside Hebrew got a 200 and lost English — and the response is a
   * re-read, so the loss was visible only to a caller that diffed the reply
   * against what it sent, and invisible to anything that did the normal thing
   * and trusted the success.
   *
   * **It now refuses a list longer than one with a 422**, so nothing is
   * dropped silently. The array shape stays, because it is the contract for
   * when a second column exists.
   *
   * The UI is still single-select — one stored language is still one stored
   * language — but the reason has changed from "a control here would lose
   * data" to "there is nothing to put in a second slot". That matters for
   * whoever builds the multi-select later: the blocker is storage now, not a
   * silent failure, and the endpoint will tell them so.
   */
  languages: z.array(z.string()).default([]),
  /** ISO-4217, for prices the AI quotes. Not the billing currency. */
  currency: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
  /** Null when the setting has never been written, or would not parse. */
  hours: businessHoursSchema.nullable().optional(),
  /**
   * The later of the profile's and the hours' timestamps, and the value to
   * send back as `If-Match`. A concurrency check that watched only one of two
   * writable sources would miss half the conflicts.
   */
  updatedAt: z.string().nullable().optional(),
  /**
   * Who last wrote each field — screen 11b.
   *
   * `"scan"` · `"human"` · **`null`, which means UNKNOWN and NOT "from the
   * website"**. The route repeats that warning where it builds the map,
   * because reading null as scan-owned is the single mistake that would make
   * a rescan overwrite somebody's correction.
   *
   * Stored in `TenantSetting` under `profileFieldProvenance`, not in a column
   * — which is why a schema search says this does not exist. It was written
   * for this screen: *"Screen 11b's mechanic is: Scan again re-reads the site
   * and only touches fields marked From website; anything typed stays."*
   */
  fieldSources: z.record(z.string(), z.enum(['scan', 'human']).nullable()).default({}),
});

export type Workspace = z.infer<typeof workspaceSchema>;

/** The fields the provenance map tracks, in the service's own order. */
export const PROVENANCED_FIELDS = [
  'organizationName',
  'businessDescription',
  'primaryLanguage',
  'industry',
  'country',
  'address',
  'currency',
] as const;

export type FieldOrigin = 'scan' | 'human' | 'unknown';

/**
 * How a field should be labelled.
 *
 * Three states, and the third is not a missing second state. The profile is
 * seeded by an onboarding confirm step that *"means two different things: 'the
 * scan proposed this' and 'the human accepted or corrected it'. Same column,
 * same statement."* So an unmarked field is genuinely unattributable, and
 * saying *"from the website"* about one would be a guess presented as a fact.
 */
export function fieldOrigin(workspace: Workspace, field: string): FieldOrigin {
  return workspace.fieldSources?.[field] ?? 'unknown';
}

/**
 * Is anything at all marked?
 *
 * **Today, on every tenant in the estate, no.** `profileFieldProvenance` has
 * zero rows across the whole database, so a rescan currently applies nothing
 * and offers everything.
 *
 * The map is self-healing — once a scan writes a field through the service,
 * that field is marked and refreshes silently forever after — so the true
 * sentence is *"the first scan will ask about everything; after that it
 * refreshes what it owns"*. That is a statement about a system that improves,
 * not an apology, and it is the only honest thing to put beside a set of
 * badges that will all be blank.
 */
export function anyFieldAttributed(workspace: Workspace): boolean {
  return Object.values(workspace.fieldSources ?? {}).some((v) => v !== null);
}

/**
 * `country` arrives as the literal string `"unknown"` on this tenant.
 *
 * Rendered as-is it reads as a country called "unknown". Treated as blank it
 * reads as a field nobody filled in — which is also wrong, and differently:
 * we DID look, and what we found was unusable.
 */
export function isUnusableValue(value: string | null | undefined): boolean {
  return value == null || value.trim() === '' || value.trim().toLowerCase() === 'unknown';
}

/**
 * How the business sounds.
 *
 * Three states, not two. `none` (nothing learned yet) and `learned`
 * (derived from the business's own past messages, untouched) offer different
 * actions, and `edited` is the one the import pipeline refuses to overwrite.
 */
export const VOICE_SOURCES = ['none', 'learned', 'edited'] as const;
export type VoiceSource = (typeof VOICE_SOURCES)[number];

export const VOICE_MIN = 40;
export const VOICE_MAX = 1800;

export const workspaceVoiceSchema = z.looseObject({
  guidance: z.string().nullable().optional(),
  source: z.enum(VOICE_SOURCES).catch('none'),
  editedAt: z.string().nullable().optional(),
  /**
   * Provenance for the guidance. Still a hardcoded stub server-side —
   * `workspace.ts:303`, `:336` and `:366` all send
   * `{ messagesAnalysed: null, importedAt: null }` — so the screen renders
   * `source` and omits these. A provenance claim built from a placeholder is
   * worse than none.
   *
   * ── WHY THIS BROKE, AND WHY THE BREAK WAS BACKWARDS ──
   * The stub used to send `0`. Backend's `6a9ffa58` changed it to `null`,
   * which is **more truthful**: zero messages analysed is a claim, and null
   * is "we do not know". This schema said `z.number().default(0)`, which
   * fills `undefined` and REJECTS an explicit null — so the guard refused an
   * improvement, because the less truthful shape had been encoded as
   * required.
   *
   * The refusal itself was correct behaviour: the whole voice editor
   * disappeared behind "the voice could not be loaded just now" rather than
   * rendering against a payload it did not understand. **A contract that
   * fails closed will sometimes fail on good news.** That is the price, and
   * it is the right one — but it is worth knowing the direction it can come
   * from, because a backend making its own payload more honest is not the
   * change anyone watches for.
   *
   * `nullable`, not just optional: the field is PRESENT and null, and those
   * are different states. `default(null)` covers a payload that omits it.
   */
  basis: z
    .looseObject({
      messagesAnalysed: z.number().nullable().default(null),
      importedAt: z.string().nullable().optional(),
    })
    .optional(),
  /**
   * An empty write is a REVERT, not a delete: it clears the edit stamp so the
   * next import can learn the voice again. "We threw your text away" and "we
   * handed this back to the learner" look identical from a blank box, so the
   * server says which, and the screen must too.
   */
  reverted: z.boolean().optional(),
});

export type WorkspaceVoice = z.infer<typeof workspaceVoiceSchema>;

export const voiceSampleSchema = z.looseObject({ reply: z.string() });

export const prohibitedClaimsSchema = z.looseObject({
  claims: z.array(z.string()).default([]),
});

export type ProhibitedClaims = z.infer<typeof prohibitedClaimsSchema>;
