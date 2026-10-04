import { z } from 'zod';

/**
 * Connecting a WhatsApp number — screens 13c and 13d.
 *
 * `POST /api/channels/whatsapp/inspect` → the numbers on the customer's
 * account, each with the decision that would apply to it.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE DESIGN HAS TWO DOORS AND THE PLATFORM HAS NONE
 * ════════════════════════════════════════════════════════════════════════════
 * 13c asks the merchant where their number lives — a new install, or an
 * existing WhatsApp Business app. `selectFlow` takes
 * `{ inspection, targetPhoneNumberId?, preferredWabaId? }` and no
 * customer-supplied choice. `POST /inspect` does accept a `path` in its body
 * and stores it on the signup session, and **nothing reads it back.**
 *
 * So the doors are not redundant with detection, they are inert: pick either
 * and the same decision comes back. A control that decides nothing is worse
 * than an absent one, because the person believes they chose.
 *
 * One list, then. Each row carries what would happen to that number.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * AND THE COPY IS THE PLATFORM'S
 * ════════════════════════════════════════════════════════════════════════════
 * `customerMessage` is documented as *"the text the connect screen shows, so
 * it says what will happen rather than what we detected"* — authored for this
 * screen, in the customer's register, with no Meta vocabulary. Rendered
 * verbatim, like `metaSolution` and `ESTIMATE_DISCLAIMER`. Six sentences of
 * our own would compete with six of theirs and drift the first time a
 * scenario changed meaning.
 */

export const SCENARIOS = [
  'NEW_NUMBER',
  'COEXISTENCE',
  'EXISTING_CLOUD_API',
  'RECONNECT',
  'MIGRATION',
  'BLOCKED',
] as const;
export type Scenario = (typeof SCENARIOS)[number];

/** Something only the customer can do. Mirrors `WhatsAppPendingAction`. */
export const CUSTOMER_ACTIONS = [
  'TWO_STEP_PIN',
  'VERIFICATION_CODE',
  'BUSINESS_APP_CONFIRMATION',
  'BUSINESS_VERIFICATION',
  'DISPLAY_NAME_REVIEW',
] as const;
export type CustomerAction = (typeof CUSTOMER_ACTIONS)[number];

export const candidateSchema = z.object({
  phoneNumberId: z.string(),
  phoneNumber: z.string().nullable().default(null),
  name: z.string().nullable().default(null),
  /** Coexistence: the number is live in the WhatsApp Business app. */
  usesBusinessApp: z.boolean().default(false),
  /** Already ours. A reconnect is a repair, not a new connection. */
  alreadyConnectedHere: z.boolean().default(false),
  scenario: z.enum(SCENARIOS),
  /** The platform's sentence for this row. Never rewritten. */
  message: z.string().nullable().default(null),
  customerAction: z.enum(CUSTOMER_ACTIONS).nullable().default(null),
  /** Why nothing can proceed, in plain language. */
  blockers: z.array(z.string()).default([]),
});

export type Candidate = z.infer<typeof candidateSchema>;

export const inspectResponseSchema = z.object({
  sessionId: z.string(),
  candidates: z.array(candidateSchema).default([]),
});

export type InspectResponse = z.infer<typeof inspectResponseSchema>;

/* ── What a row is allowed to offer ──────────────────────────────────────── */

/** Can this number be connected at all? */
export function isConnectable(candidate: Candidate): boolean {
  return candidate.scenario !== 'BLOCKED';
}

/**
 * Will the customer be asked for their two-step PIN?
 *
 * Known BEFORE anything is submitted, because it is a field on the candidate
 * rather than something discovered when the register step fails. So the
 * screen says it before the click, which is the whole point of having it.
 */
export function needsPin(candidate: Candidate): boolean {
  return candidate.customerAction === 'TWO_STEP_PIN';
}

/**
 * The two kinds of impossibility, which need different sentences.
 *
 * `BLOCKED` is *not you, not now* — a blocker the customer can clear.
 * `fullMigration` is *not anyone, not ever*: Meta publishes no API for moving
 * a Business app number to Cloud API, so `available` is typed as the literal
 * `false`. A greyed-out control for the second reads as "you did not qualify",
 * and this merchant did not fail a check — the road does not exist.
 */
export type Impossibility = 'blocked_for_now' | 'never_available';

export const businessAppOptionsSchema = z.object({
  keepUsingBusinessApp: z.object({
    title: z.string(),
    description: z.string(),
    /** Meta caps Coexistence numbers at 20 messages per second. */
    throughputNote: z.string().nullable().default(null),
    limitations: z.array(z.string()).default([]),
  }),
  fullMigration: z.object({
    /**
     * Always false. Typed as a literal upstream, for every Business app
     * number that will ever exist — not a per-tenant verdict.
     */
    available: z.literal(false),
    title: z.string(),
    /** Why it is not offered, in the customer's language. Rendered as PROSE. */
    reason: z.string(),
  }),
});

export type BusinessAppOptions = z.infer<typeof businessAppOptionsSchema>;

/** Does this row need the coexistence explanation beneath it? */
export function explainsCoexistence(candidate: Candidate): boolean {
  return candidate.usesBusinessApp || candidate.scenario === 'COEXISTENCE';
}

/**
 * `GET /api/channels/config` → `data.embeddedSignup`: how to launch Meta's
 * Embedded Signup, as the server says. Named fields only; `configured: false`
 * (or no block at all) means the launcher is drawn, with why.
 */
export const embeddedSignupLaunchSchema = z.object({
  appId: z.string().default(''),
  configId: z.string().default(''),
  responseType: z.literal('code').catch('code'),
  overrideDefaultResponseType: z.boolean().default(true),
  extras: z.record(z.string(), z.unknown()).default({}),
  configured: z.boolean().default(false),
  /**
   * Backend 294adc0c: what `POST /whatsapp/inspect` takes as `path` for this
   * choice. On Embedded Signup v4 the choice itself happens in Meta's dialog;
   * this steers the inspect.
   */
  inspectPath: z.enum(['business-app', 'new']).catch('new').default('new'),
});
export type EmbeddedSignupLaunch = z.infer<typeof embeddedSignupLaunchSchema>;

export const channelsConfigSchema = z.object({
  embeddedSignup: embeddedSignupLaunchSchema.nullish().default(null),
  /** Both 13c choices in one read (backend 294adc0c). */
  embeddedSignupByMode: z
    .object({
      coexistence: embeddedSignupLaunchSchema.nullish().default(null),
      new_number: embeddedSignupLaunchSchema.nullish().default(null),
    })
    .nullish()
    .catch(null)
    .default(null),
  /**
   * Whether each OAuth provider's app credentials exist — a `false` one can
   * never complete, so its Connect is drawn "not set up" up front.
   */
  providers: z.record(z.string(), z.boolean()).nullish().catch(null).default(null),
});
