import { z } from 'zod';

/**
 * Self sign-up and sign-up by domain (Omer, 2026-11-22) - every wire the web
 * side reads, in one file.
 *
 * Backend's shape (accepted by the Supervisor, 2026-11-22):
 *
 *   GET  /api/auth/signup/config (public)
 *          → { enabled, trialDays, cardRequiredAfterDays }
 *   POST /api/auth/signup (public)
 *          { name, email, businessName, locale, terms, privacy, capturedText?, website? }
 *          → 202 { ok: true } in EVERY accepted case (new, known, domain join)
 *          · 400 { error: "validation", fields: { <field>: required|invalid|too_long } }
 *          · 429 rate_limited · 404 signup_disabled
 *          `website` is the honeypot: hidden, empty; filled is a silent 202.
 *   GET/PUT /api/system/self-signup (system admin)
 *          { enabled, trialDays, cardRequiredAfterDays, trialCredits, envEnabled, bounds }
 *   GET/PUT /api/tenant/security/join-domain (tenant admin)
 *          { domain, joinByDomain, publicDomain } · 409 public_domain | domain_taken
 *   GET  /api/checkout/mine → data.reason: "card_required" (checkout null)
 */

/* ── The public config ───────────────────────────────────────────────────── */

const days = z.number().int().positive();

/** Off, or unread, is the same to a visitor: no link, no page. */
export const signUpConfigSchema = z.looseObject({
  enabled: z.boolean().catch(false),
  /** Optional: without both numbers the trial line is not drawn. */
  trialDays: days.nullable().catch(null).default(null),
  cardRequiredAfterDays: days.nullable().catch(null).default(null),
});
export type SignUpConfig = z.infer<typeof signUpConfigSchema>;

/* ── The submit ──────────────────────────────────────────────────────────── */

export interface SignUpForm {
  readonly name: string;
  readonly email: string;
  readonly businessName: string;
}

/** The fields a refusal can name, so the screen can point at one. */
export const SIGN_UP_FIELDS = ['name', 'email', 'businessName'] as const;
export type SignUpField = (typeof SIGN_UP_FIELDS)[number];

/**
 * The body: the form, trimmed, plus the setup screen's Terms fields, plus the
 * honeypot exactly as the hidden field held it (empty for a person).
 */
export function signUpBody(form: SignUpForm, locale: string, capturedText: string, website = '') {
  return {
    name: form.name.trim(),
    email: form.email.trim(),
    businessName: form.businessName.trim(),
    terms: true as const,
    privacy: true as const,
    locale: locale.startsWith('he') ? ('he' as const) : ('en' as const),
    capturedText: capturedText.trim().slice(0, 1000),
    website,
  };
}

/** Whatever the 2xx carries: it says nothing about the address, by design. */
export const signUpSentSchema = z.unknown();

/**
 * What a sign-up came to, as the screen tells it.
 * ★ `sent` for every accepted request: the answer must not say whether the
 *   address already has an account (no account list from this form).
 */
export type SignUpOutcome =
  | { readonly kind: 'sent' }
  | { readonly kind: 'invalid'; readonly field: SignUpField | null }
  | { readonly kind: 'rateLimited' }
  | { readonly kind: 'closed' }
  | { readonly kind: 'failed' };

/**
 * The submit's answer, read by its status: every 2xx is `sent` (Backend
 * answers 202 alike for a new, known or domain-joining address).
 */
export function readSignUpAnswer(status: number, body: unknown): SignUpOutcome {
  if (status >= 200 && status < 300) return { kind: 'sent' };
  if (status === 429) return { kind: 'rateLimited' };
  if (status === 404 || status === 403) return { kind: 'closed' };
  if (status === 400 || status === 422) {
    const fields =
      body !== null && typeof body === 'object' && 'fields' in body
        ? (body as { fields?: unknown }).fields
        : undefined;
    return {
      kind: 'invalid',
      field:
        fields !== null && typeof fields === 'object'
          ? refusedFieldOf(fields as Record<string, unknown>)
          : null,
    };
  }
  return { kind: 'failed' };
}

/** The first form field a 400's `fields` map names, or null. */
export function refusedFieldOf(
  fields: Readonly<Record<string, unknown>> | undefined,
): SignUpField | null {
  for (const key of Object.keys(fields ?? {})) {
    const field = signUpFieldOf(key);
    if (field) return field;
  }
  return null;
}

export function signUpFieldOf(raw: unknown): SignUpField | null {
  return typeof raw === 'string' && (SIGN_UP_FIELDS as readonly string[]).includes(raw)
    ? (raw as SignUpField)
    : null;
}

/* ── The console's settings ──────────────────────────────────────────────── */

const range = z
  .looseObject({ min: z.number().int(), max: z.number().int() })
  .nullable()
  .catch(null)
  .default(null);

/** The three numbers the console sets, in the order the card draws them. */
export const SIGN_UP_NUMBERS = ['trialDays', 'cardRequiredAfterDays', 'trialCredits'] as const;
export type SignUpNumber = (typeof SIGN_UP_NUMBERS)[number];

export const signUpSettingsSchema = z.looseObject({
  enabled: z.boolean(),
  trialDays: days,
  cardRequiredAfterDays: days,
  trialCredits: days,
  /** `false`: the env switch is off, and the setting alone does nothing. */
  envEnabled: z.boolean().catch(true).default(true),
  /** The server's limits per number; a missing one only marks the field, never words it. */
  bounds: z
    .looseObject({ trialDays: range, cardRequiredAfterDays: range, trialCredits: range })
    .catch({ trialDays: null, cardRequiredAfterDays: null, trialCredits: null })
    .default({ trialDays: null, cardRequiredAfterDays: null, trialCredits: null }),
});
export type SignUpSettings = z.infer<typeof signUpSettingsSchema>;

export type SignUpSettingsWrite = Pick<SignUpSettings, 'enabled' | SignUpNumber>;

export function signUpSettingsBody(settings: SignUpSettingsWrite) {
  return {
    enabled: settings.enabled,
    trialDays: settings.trialDays,
    cardRequiredAfterDays: settings.cardRequiredAfterDays,
    trialCredits: settings.trialCredits,
  };
}

/* ── Joining by domain ───────────────────────────────────────────────────── */

export const domainJoinSchema = z.looseObject({
  /** The admin's own email domain. */
  domain: z.string().min(1),
  joinByDomain: z.boolean(),
  /** gmail.com and the like: shown, never switchable. */
  publicDomain: z.boolean().catch(false).default(false),
});
export type DomainJoin = z.infer<typeof domainJoinSchema>;

/** Why a domain join was refused (409). */
export const DOMAIN_JOIN_REFUSALS = {
  publicDomain: 'public_domain',
  taken: 'domain_taken',
} as const;

/* ── The card the trial asks for, on the payment page ───────────────────── */

/**
 * `GET /api/checkout/mine`'s `data.reason`: "card_required" for an
 * organization the trial sweep blocked. Not "the trial ended" - the trial
 * itself may still be running (Backend).
 */
export function cardRequired(reason: unknown): boolean {
  return reason === 'card_required';
}
