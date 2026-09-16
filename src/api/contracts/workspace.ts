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
   * PATCH keeps only `languages[0]`, so a round trip silently drops the rest.
   * The UI is single-select until the column catches up — deliberately, so no
   * control accepts two languages and forgets one.
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
});

export type Workspace = z.infer<typeof workspaceSchema>;

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
   * Provenance for the guidance. Currently a hardcoded stub server-side
   * (`{ messagesAnalysed: 0, importedAt: null }`), so the screen renders
   * `source` and omits these — a provenance claim built from zeroes is worse
   * than none.
   */
  basis: z
    .looseObject({
      messagesAnalysed: z.number().default(0),
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
