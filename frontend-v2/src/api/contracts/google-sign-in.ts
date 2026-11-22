import { z } from 'zod';

/**
 * Sign in with Google (Omer, 2026-11-22) - every wire the web side reads,
 * in one file. Backend's contract: feat/google-signin at ff3a1b9f
 * (services/auth routes/account.ts and setup-link.ts).
 *
 *   GET    /api/account/sign-in-connections
 *            → { google: { available, connected, email, connectedAt, canDisconnect, reason } }
 *            409 { error: "no_identity" } · 502 { error: "idp_unavailable" }
 *   DELETE /api/account/sign-in-connections/google → { ok: true }
 *            409 no_other_sign_in · 404 not_connected · 404 not_available · 502 idp_unavailable
 *   POST   /api/account/security/sign-in { connectSubject? }
 *            → { method, google, termsRequired } - always a 200
 *   GET    /api/account/terms → { termsRequired } · 503 { error: "unavailable" }
 *   POST   /api/account/terms/accept { terms, privacy, locale, capturedText }
 *            → { termsRequired: false } · 400 consent_required · 403 forbidden · 503 unavailable
 *   GET    /api/auth/setup/:token/state → { data: { …, google } }
 *
 * Plain JSON, like their siblings: no `data` envelope except the setup state.
 */

/** `available: false`: Google is not set up in this environment - the card is not drawn. */
const googleConnectionSchema = z.looseObject({
  available: z.boolean(),
  connected: z.boolean(),
  /** The person's GOTCHA email when connected: the link is by email match. */
  email: z.string().nullable().catch(null).default(null),
  connectedAt: z.string().nullable().catch(null).default(null),
  canDisconnect: z.boolean().catch(false).default(false),
  /** `"no_other_sign_in"` when connected and it cannot be removed. */
  reason: z.string().nullable().catch(null).default(null),
});
export type GoogleConnection = z.infer<typeof googleConnectionSchema>;

export const signInConnectionsSchema = z.looseObject({ google: googleConnectionSchema });

/** Why a disconnect was refused, as the route says it. */
export const DISCONNECT_REFUSALS = {
  noOtherSignIn: 'no_other_sign_in',
  notConnected: 'not_connected',
  notAvailable: 'not_available',
} as const;

export const disconnectedSchema = z.looseObject({ ok: z.literal(true) });

/**
 * The sign-in record our callback posts. Read leniently: it is best effort,
 * and an odd field means "no marker", never a failed sign-in.
 */
export const signInRecordSchema = z.looseObject({
  method: z.string().catch('unknown').default('unknown'),
  google: z.enum(['connected', 'other_account']).nullable().catch(null).default(null),
  termsRequired: z.boolean().catch(false).default(false),
});
export type SignInRecord = z.infer<typeof signInRecordSchema>;

export const termsStateSchema = z.looseObject({ termsRequired: z.boolean() });

/** The accept body: the setup screen's, word for word (`SetupAcceptBody`). */
export function termsAcceptBody(
  locale: string,
  capturedText: string,
): {
  readonly terms: true;
  readonly privacy: true;
  readonly locale: 'he' | 'en';
  readonly capturedText: string;
} {
  return {
    terms: true,
    privacy: true,
    locale: locale.startsWith('he') ? 'he' : 'en',
    capturedText: capturedText.trim().slice(0, 1000),
  };
}

/** The setup link's state - read for the Google flag, and the address it went to. */
export const setupStateSchema = z.looseObject({
  /** `true`: the Google button may be offered on the setup page. Absent: it is not. */
  google: z.boolean().catch(false).default(false),
  /** The invited address, for "use the Google account for …"; null on a dead link. */
  email: z.string().nullable().catch(null).default(null),
});

/**
 * The markers in a URL, each from a fixed list. Anybody can type one, so
 * none of them grants anything: each only picks a sentence, and they are
 * never carried into `returnTo`.
 */
export const SIGN_IN_GOOGLE_MARKERS = ['no-account', 'cancelled', 'failed', 'start'] as const;
export type SignInGoogleMarker = (typeof SIGN_IN_GOOGLE_MARKERS)[number];
export const ACCOUNT_GOOGLE_MARKERS = ['connected', 'other_account'] as const;
export type AccountGoogleMarker = (typeof ACCOUNT_GOOGLE_MARKERS)[number];

export function markerOf<T extends string>(raw: unknown, known: readonly T[]): T | null {
  return typeof raw === 'string' && (known as readonly string[]).includes(raw) ? (raw as T) : null;
}
