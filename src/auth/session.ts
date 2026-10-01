import 'server-only';

import { hkdf } from 'node:crypto';
import { promisify } from 'node:util';

import { CompactEncrypt, compactDecrypt } from 'jose';
import { z } from 'zod';

import { serverEnv } from '@/config/env.server';
import { appPath } from '@/lib/base-path';

const hkdfAsync = promisify(hkdf);

/**
 * What the session cookie holds.
 *
 * Tokens live here and nowhere else. They are never written to
 * `localStorage`, never embedded in HTML, and never sent to the browser: the
 * cookie is HttpOnly and its contents are encrypted, so even a successful XSS
 * cannot read the access token out of it.
 *
 * Short keys keep the cookie comfortably inside the 4 KB browser limit, and
 * the OIDC id token is deliberately NOT kept here - see MAX_COOKIE_BYTES.
 */
const sessionSchema = z.object({
  /** Authentik subject (`sub`). Maps to `User.authentikSubject` server-side. */
  sub: z.string().min(1),
  /** Opaque local session id. Used for correlation; carries no PII. */
  sid: z.string().min(1),
  /** Access token presented to the platform API as a bearer token. */
  at: z.string().min(1),
  /** Refresh token, when `offline_access` was granted. */
  rt: z.string().min(1).optional(),
  /** Access token expiry, epoch seconds. */
  exp: z.number().int().positive(),
  /** Absolute session expiry, epoch seconds. Independent of token refresh. */
  abs: z.number().int().positive(),
  /** The active tenant. Sent as `X-Tenant-Id` on every upstream request. */
  tid: z.string().min(1).optional(),
});

export type Session = z.infer<typeof sessionSchema>;

const ENCRYPTION = { alg: 'dir', enc: 'A256GCM' } as const;

let keyPromise: Promise<CryptoKey> | undefined;

/**
 * Derives the content-encryption key from `SESSION_SECRET`.
 *
 * HKDF rather than using the secret directly, so the secret can be any
 * sufficiently random string rather than exactly 32 bytes, and so the same
 * secret could safely derive other purpose-bound keys later.
 */
function encryptionKey(): Promise<CryptoKey> {
  keyPromise ??= (async () => {
    const derived = (await hkdfAsync(
      'sha256',
      serverEnv().SESSION_SECRET,
      'gotcha.session.v1',
      'gotcha.session.encryption',
      32,
    )) as ArrayBuffer;
    return globalThis.crypto.subtle.importKey('raw', derived, 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ]);
  })();
  return keyPromise;
}

/**
 * Browsers cap a single cookie at 4096 bytes of `name=value` and DISCARD
 * anything larger - silently, with no error anywhere. The symptom is an
 * infinite redirect loop: sign-in succeeds, the cookie never comes back, the
 * middleware bounces to sign-in again.
 *
 * We hit exactly that by storing the OIDC id token. Measured: a session
 * carrying one sealed to 4868 bytes. The id token is gone (logout identifies
 * the client by `client_id` instead), which leaves ~3000 bytes of plaintext
 * budget against a typical 1770.
 *
 * This guard exists so the failure can never be silent again.
 */
export const MAX_COOKIE_BYTES = 4096;

export class SessionTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`sealed session is ${bytes} bytes; browsers discard cookies over ${MAX_COOKIE_BYTES}`);
    this.name = 'SessionTooLargeError';
  }
}

export async function sealSession(session: Session): Promise<string> {
  const key = await encryptionKey();
  const sealed = await new CompactEncrypt(new TextEncoder().encode(JSON.stringify(session)))
    .setProtectedHeader(ENCRYPTION)
    .encrypt(key);

  const cookieBytes = serverEnv().SESSION_COOKIE_NAME.length + 1 + sealed.length;
  if (cookieBytes > MAX_COOKIE_BYTES) throw new SessionTooLargeError(cookieBytes);

  return sealed;
}

/**
 * Decrypts and validates a session cookie.
 *
 * Returns `null` for anything that is not a currently-valid session -
 * tampered, encrypted under a rotated secret, malformed, or past its absolute
 * expiry. Callers treat `null` as "signed out"; there is no partial trust.
 */
export async function unsealSession(sealed: string | undefined): Promise<Session | null> {
  if (!sealed) return null;
  try {
    const key = await encryptionKey();
    const { plaintext } = await compactDecrypt(sealed, key);
    const parsed = sessionSchema.safeParse(JSON.parse(new TextDecoder().decode(plaintext)));
    if (!parsed.success) return null;
    if (parsed.data.abs <= nowInSeconds()) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export function nowInSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Access tokens are refreshed slightly early, to avoid racing expiry. */
const REFRESH_SKEW_SECONDS = 60;

export function isAccessTokenExpired(session: Session): boolean {
  return session.exp - REFRESH_SKEW_SECONDS <= nowInSeconds();
}

/** Cookie attributes. `Secure` is dropped only for plain-HTTP localhost. */
/**
 * The id token, sealed, in a cookie of its own.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ WHY IT IS NOT IN THE SESSION, AND WHY THAT WAS THE WRONG CONCLUSION
 * ════════════════════════════════════════════════════════════════════════════
 * `sessionSchema` records that the id token is "deliberately NOT kept here —
 * see MAX_COOKIE_BYTES", and that was correct: adding it pushed the session
 * cookie past the browser's limit. The conclusion drawn from it was that we
 * therefore could not keep an id token at all, and **that does not follow.**
 *
 * ⚠ THE 4 KB LIMIT IS PER COOKIE, NOT PER DOMAIN. Measured 2026-10-01: a live
 *   `gotcha_session` is 2,600 bytes with 1,481 of headroom, and a second
 *   cookie gets its own 4,096 ceiling.
 *
 * ★ So it lives beside the session rather than inside it, scoped to the one
 *   path that reads it. `gotcha_login` already does exactly this with
 *   `path=/v2/api/auth`, so the technique is proven in this codebase rather
 *   than borrowed.
 *
 * ── WHAT IT BUYS ──
 * RP-initiated logout without an `id_token_hint` can only offer `client_id`,
 * which does not tell the provider WHO is signing out — so it asks the person
 * to confirm, on its own page, in its own vocabulary. That confirmation screen
 * is the whole cost, and it is the one a reviewer photographed.
 *
 * ⚠ IT IS SENT ON NOTHING ELSE. Scoped to the logout path, it adds zero bytes
 *   to every other request — which is the reason it can exist at all on a
 *   product that already carries 2.6 KB of session.
 */
export const ID_TOKEN_COOKIE = 'gotcha_id_token';

/** Only the logout route ever reads it. */
export const ID_TOKEN_COOKIE_PATH = appPath('/api/auth/logout');

export function idTokenCookieOptions(): {
  name: string;
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge: number;
} {
  const env = serverEnv();
  return {
    name: ID_TOKEN_COOKIE,
    httpOnly: true,
    secure: !env.APP_ORIGIN.startsWith('http://'),
    sameSite: 'lax',
    path: ID_TOKEN_COOKIE_PATH,
    /* It is useless once the session it describes is gone. */
    maxAge: env.SESSION_MAX_AGE_SECONDS,
  };
}

/**
 * Seals an id token for that cookie.
 *
 * ⚠ THROWS RATHER THAN TRUNCATES. A truncated `id_token_hint` is worse than an
 *   absent one: the provider cannot verify it, and what it does with a
 *   malformed hint is unspecified. The caller omits the cookie and the logout
 *   falls back to `client_id` — a confirmation screen, which is a cost, where
 *   a broken hint risks a sign-out that does not sign out.
 */
export async function sealIdToken(idToken: string): Promise<string> {
  const key = await encryptionKey();
  const sealed = await new CompactEncrypt(new TextEncoder().encode(idToken))
    .setProtectedHeader(ENCRYPTION)
    .encrypt(key);

  const cookieBytes = ID_TOKEN_COOKIE.length + 1 + sealed.length;
  if (cookieBytes > MAX_COOKIE_BYTES) throw new SessionTooLargeError(cookieBytes);

  return sealed;
}

/** Decrypts it, or `null` for anything that is not currently readable. */
export async function unsealIdToken(sealed: string | undefined): Promise<string | null> {
  if (!sealed) return null;
  try {
    const key = await encryptionKey();
    const { plaintext } = await compactDecrypt(sealed, key);
    const token = new TextDecoder().decode(plaintext);
    return token === '' ? null : token;
  } catch {
    /*
     * Tampered, or encrypted under a rotated secret. Treated as absent, which
     * costs a confirmation screen — never as a reason to fail the sign-out.
     */
    return null;
  }
}

export function sessionCookieOptions(): {
  name: string;
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge: number;
} {
  const env = serverEnv();
  return {
    name: env.SESSION_COOKIE_NAME,
    httpOnly: true,
    secure: !env.APP_ORIGIN.startsWith('http://'),
    // `lax` keeps the cookie on the top-level redirect back from Authentik
    // while still withholding it from cross-site form posts.
    sameSite: 'lax',
    /*
     * ★★ THERE IS NO `domain`, AND ITS ABSENCE IS LOAD-BEARING.
     * Without one the cookie is HOST-ONLY: set on the product's host, never
     * sent to the sign-in origin. That is what keeps a signed-in visitor from
     * rendering a product page there through the one gap in the middleware's
     * matcher — it skips any path containing a dot, so
     * `/en/customers/a.b@c.com` reaches the app with no refusal in front of
     * it, and only the absent session turns it away.
     *
     * Adding a `domain` to share this across subdomains is a reasonable thing
     * to want. Doing it opens that path. See `refuseOnCredentialSurface`.
     */
    path: '/',
    maxAge: env.SESSION_MAX_AGE_SECONDS,
  };
}
