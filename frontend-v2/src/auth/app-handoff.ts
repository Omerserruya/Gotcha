import 'server-only';

import { CompactEncrypt, compactDecrypt } from 'jose';
import { z } from 'zod';

import { serverEnv } from '@/config/env.server';

import { LOGIN_STATE_COOKIE_PATH, LOGIN_STATE_MAX_AGE_SECONDS } from './login-state';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ GOOGLE INSIDE THE APP: THE SIGN-IN CROSSES FROM THE SYSTEM BROWSER
 * ════════════════════════════════════════════════════════════════════════════
 * Google refuses an embedded WebView, so the app runs the whole sign-in in the
 * phone's own auth browser (iOS ASWebAuthenticationSession, ephemeral; Android
 * Custom Tabs) - the website's flow, unchanged: Google, the Authentik source
 * with email_link, gotcha-google-no-account for an unknown email, the org's
 * two-step, our callback. What changes is the END: the session is born in the
 * system browser's cookie jar, and the app's WebView is a different jar.
 *
 *   1. The app makes a random verifier and opens
 *      /api/bff/app-sign-in/start?challenge=S256(verifier) in the auth browser.
 *      Start seals the challenge into a cookie (`APP_HANDOFF_COOKIE`) and
 *      sends the browser to /<locale>/sign-in?google=start.
 *   2. The callback finds that cookie and, instead of setting our session
 *      cookies there, puts them in a CODE: a JWE, 60 seconds, holding the
 *      sealed session, the sealed ID token, the Terms marker and the
 *      challenge. It redirects to gotcha://auth/done?code=… - the app's own
 *      scheme, which closes the auth browser and hands the URL to the app.
 *   3. The app POSTs { code, verifier } from inside the WebView to
 *      /api/bff/app-sign-in/redeem, which checks the time and that
 *      S256(verifier) is the challenge, then sets the cookies in the WebView.
 *
 * ★ BOUND TO THE VERIFIER, which never leaves the app: a code caught by some
 *   other app claiming gotcha:// is useless to it. Not single-use - there is
 *   no server store, and none may be added - but 60 seconds and the verifier.
 * ★ Under /api/bff/ because the gateway gives that prefix to this app on dev
 *   and prod; a new /api/auth/* path would go to the auth service.
 */

/** The start's cookie: the challenge, until the callback. */
export const APP_HANDOFF_COOKIE = 'gotcha_app_handoff';
/** Where the callback reads it: the login state's own scope. */
export const APP_HANDOFF_COOKIE_PATH = LOGIN_STATE_COOKIE_PATH;
/** As long as the sign-in itself may take. */
export const APP_HANDOFF_MAX_AGE_SECONDS = LOGIN_STATE_MAX_AGE_SECONDS;
/** How long the code lives between the callback and the app's redeem. */
export const APP_HANDOFF_CODE_SECONDS = 60;
/** Where the callback sends the code: the app's registered scheme. */
export const APP_HANDOFF_RETURN = 'gotcha://auth/done';

/** The provider's session cookie, which the start expires (see its route). */
export const AUTHENTIK_SESSION_COOKIE = 'authentik_session';

/** `app.gotcha.co.il` -> `gotcha.co.il`; a bare host or `localhost` has none. */
export function apexOf(host: string): string | null {
  const labels = host.split('.');
  return labels.length >= 3 ? labels.slice(1).join('.') : null;
}

/** RFC 7636: base64url, 43 to 128 characters. A S256 challenge is exactly 43. */
const VERIFIER = /^[A-Za-z0-9_-]{43,128}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

export function isChallenge(value: string | null | undefined): value is string {
  return typeof value === 'string' && CHALLENGE.test(value);
}

export function isVerifier(value: unknown): value is string {
  return typeof value === 'string' && VERIFIER.test(value);
}

const startSchema = z.object({
  /** Which object this is: never mistaken for the code, or a login state. */
  k: z.literal('app-start'),
  c: z.string().regex(CHALLENGE),
});

const codeSchema = z.object({
  k: z.literal('app-code'),
  c: z.string().regex(CHALLENGE),
  /** Expiry, seconds. */
  e: z.number().int(),
  /** The sealed session cookie, as the callback would have set it. */
  s: z.string().min(1),
  /** The sealed ID token cookie, or none (it did not fit). */
  i: z.string().min(1).nullable(),
  /** The Terms marker: owed on a first Google sign-in. */
  t: z.boolean(),
});

export type HandoffSession = { readonly s: string; readonly i: string | null; readonly t: boolean };

let keyPromise: Promise<CryptoKey> | undefined;

function key(): Promise<CryptoKey> {
  keyPromise ??= globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(serverEnv().SESSION_SECRET).slice(0, 32),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  );
  return keyPromise;
}

async function seal(value: unknown): Promise<string> {
  return new CompactEncrypt(new TextEncoder().encode(JSON.stringify(value)))
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .encrypt(await key());
}

async function open(sealed: string): Promise<unknown> {
  try {
    const { plaintext } = await compactDecrypt(sealed, await key());
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return null;
  }
}

/** base64url(SHA-256(verifier)), as RFC 7636 S256 computes it. */
export async function s256(verifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  return Buffer.from(digest).toString('base64url');
}

export function sealHandoffStart(challenge: string): Promise<string> {
  return seal({ k: 'app-start', c: challenge });
}

/** The challenge the start sealed, or `null`: this sign-in is not the app's. */
export async function unsealHandoffStart(sealed: string | undefined): Promise<string | null> {
  if (!sealed) return null;
  const parsed = startSchema.safeParse(await open(sealed));
  return parsed.success ? parsed.data.c : null;
}

export function sealHandoffCode(
  challenge: string,
  session: HandoffSession,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  return seal({
    k: 'app-code',
    c: challenge,
    e: nowSeconds + APP_HANDOFF_CODE_SECONDS,
    ...session,
  });
}

/**
 * The session in the code, or `null`: unreadable, expired, or the verifier is
 * not the one the challenge was made from. One answer for all three - the
 * redeem says nothing that helps a guesser.
 */
export async function redeemHandoffCode(
  code: string,
  verifier: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<HandoffSession | null> {
  if (!isVerifier(verifier)) return null;
  const parsed = codeSchema.safeParse(await open(code));
  if (!parsed.success) return null;
  const { c, e, s, i, t } = parsed.data;
  if (nowSeconds > e) return null;
  if ((await s256(verifier)) !== c) return null;
  return { s, i, t };
}
