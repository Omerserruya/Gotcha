import { z } from 'zod';

/**
 * The WhatsApp templates every number needs (Backend 7e91418b).
 *
 * Past WhatsApp's 24-hour window only an approved template goes out, and two
 * situations hit it in every workspace: answering a customer who wrote more
 * than a day ago (`reopen`), and the idle reminder (`followup`). Each is a
 * fixed name on the server (`gotcha_reopen`, `gotcha_followup`), one per
 * workspace language, with a suggested text the person approves or edits.
 *
 * `GET /api/templates/required?channelAccountId=` answers
 * `{ data: { channelAccountId, connectionStatus, canSubmit, languages, items } }`
 * with nothing beside `data`, so the client's unwrap is right for it.
 *
 * Every field the screen reads is named here: `z.object` strips the rest.
 * A field an older server lacks reads as its safe value, and a state or role
 * this list does not know reads as itself, never as a failed read.
 */

/** The roles the server defines (`REQUIRED_ROLES`); the screen words only these. */
export const REQUIRED_ROLES = ['reopen', 'followup'] as const;
export type RequiredRole = (typeof REQUIRED_ROLES)[number];

/** `stateOf()` on the server: what this number's row is, or `missing`. */
export const REQUIRED_STATES = ['missing', 'draft', 'pending', 'approved', 'rejected'] as const;
export type RequiredState = (typeof REQUIRED_STATES)[number];

/**
 * The stored row's buttons, or the suggestion's. A row written elsewhere may
 * carry any shape; one without text is not a button the screen can show.
 */
const buttonsSchema = z
  .array(z.unknown())
  .catch([])
  .transform((list) =>
    list.flatMap((b) => {
      const text = b && typeof b === 'object' ? (b as { text?: unknown }).text : null;
      return typeof text === 'string' && text.trim() ? [text] : [];
    }),
  );

export const requiredItemSchema = z.object({
  role: z.string(),
  name: z.string().catch(''),
  language: z.string(),
  category: z.string().nullable().catch(null).default(null),
  /** Kept as sent: an unknown one reads as a neutral chip (`stateOfItem`). */
  state: z.string().catch('unknown'),
  templateId: z.string().nullable().catch(null).default(null),
  /** Meta's reason, in Meta's words (English), when it rejected or paused it. */
  reason: z.string().nullable().catch(null).default(null),
  body: z.string().catch(''),
  /** The buttons' texts. The POST takes one (`button`), and gets it back. */
  buttons: buttonsSchema.default([]),
});
export type RequiredItem = z.infer<typeof requiredItemSchema>;

export const requiredTemplatesSchema = z.object({
  channelAccountId: z.string(),
  connectionStatus: z.string().nullable().catch(null).default(null),
  /**
   * Meta accepts a template only from a connected number. Absent reads as
   * false: the safe reading of "may this be sent outward" is no.
   */
  canSubmit: z.boolean().catch(false).default(false),
  languages: z.array(z.string()).catch([]).default([]),
  items: z.array(requiredItemSchema).catch([]).default([]),
});
export type RequiredTemplates = z.infer<typeof requiredTemplatesSchema>;

/** The state as the screen words it; anything else is `unknown`. */
export function stateOfItem(item: Pick<RequiredItem, 'state'>): RequiredState | 'unknown' {
  return (REQUIRED_STATES as readonly string[]).includes(item.state)
    ? (item.state as RequiredState)
    : 'unknown';
}

export function roleOfItem(item: Pick<RequiredItem, 'role'>): RequiredRole | null {
  return (REQUIRED_ROLES as readonly string[]).includes(item.role)
    ? (item.role as RequiredRole)
    : null;
}

/**
 * Can this one be edited and sent from here? Only a role the server knows,
 * in a state it still accepts: an approved or pending one is changed in
 * Outreach (the POST answers 409 ALREADY_SUBMITTED), and an unknown state is
 * not guessed at.
 */
export function isEditable(item: RequiredItem): boolean {
  const state = stateOfItem(item);
  return (
    roleOfItem(item) !== null && (state === 'missing' || state === 'draft' || state === 'rejected')
  );
}

/** The route's own limit on a body (`BAD_BODY`: 1-1024 characters). */
export const BODY_MAX = 1024;
