import 'server-only';

import { CompactEncrypt, compactDecrypt } from 'jose';
import { z } from 'zod';

import { serverEnv } from '@/config/env.server';

import { CONNECT_COOKIE, CONNECT_COOKIE_PATH } from './google-connect-cookie';
import { sessionCookieOptions } from './session';

export { CONNECT_COOKIE, CONNECT_COOKIE_PATH };

/**
 * Sign in with Google, the server's cookies (Omer, 2026-11-22; Backend's
 * contract feat/google-signin ff3a1b9f). Both are read around our OIDC
 * callback - where every sign-in ends, Google's included. The call the
 * callback makes is `api/client/sign-in-record.ts`.
 */

/* ── Connecting Google from Settings ─────────────────────────────────────── */

/**
 * ★★ WHO STARTED THE CONNECT, HELD ACROSS A SIGN-OUT.
 *
 * Connecting is "sign out, then sign in with Google" (Supervisor): a browser
 * with a live provider session that opens the Google source links ANY Google
 * account, with no email check - so connect never starts the source while
 * signed in. The person's subject is sealed into this cookie while they are
 * still signed in; our callback hands it to Backend as `connectSubject`, and
 * Backend says "connected" only when the same subject came back.
 *
 * - Its own cookie, not the login state: that one is minted by
 *   /api/auth/login AFTER the sign-out, and the sign-out deletes the session.
 * - Never in a URL. The sign-in page only shows a hint (`?connect=google`),
 *   added by the proxy from this cookie's presence (google-connect-cookie.ts).
 * - Ten minutes, and the callback deletes it on every outcome - a leftover on
 *   a shared machine meets Backend's rule (same subject, Google method) and
 *   says nothing.
 */
export const CONNECT_MAX_AGE_SECONDS = 600;

const connectIntentSchema = z.object({ p: z.literal('google-connect'), s: z.string().min(1) });

let keyPromise: Promise<CryptoKey> | undefined;

/** The session secret's key, as the login state seals with it (login-state.ts). */
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

export async function sealConnectIntent(subject: string): Promise<string> {
  const plain = JSON.stringify({ p: 'google-connect', s: subject });
  return new CompactEncrypt(new TextEncoder().encode(plain))
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .encrypt(await key());
}

/** The subject that started a connect, or `null` for anything else. */
export async function unsealConnectIntent(sealed: string | undefined): Promise<string | null> {
  if (!sealed) return null;
  try {
    const { plaintext } = await compactDecrypt(sealed, await key());
    const parsed = connectIntentSchema.safeParse(JSON.parse(new TextDecoder().decode(plaintext)));
    return parsed.success ? parsed.data.s : null;
  } catch {
    return null;
  }
}

export function connectCookieOptions(): {
  name: string;
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge: number;
} {
  const session = sessionCookieOptions();
  return {
    name: CONNECT_COOKIE,
    httpOnly: true,
    secure: session.secure,
    // `lax`: it rides the top-level redirect back from the provider.
    sameSite: 'lax',
    path: CONNECT_COOKIE_PATH,
    maxAge: CONNECT_MAX_AGE_SECONDS,
  };
}

/* ── The Terms before first entry ────────────────────────────────────────── */

/**
 * ★★ "THIS SIGN-IN STILL OWES THE TERMS", HELD FOR AS LONG AS THE SESSION.
 *
 * Set by the callback only when Backend's sign-in record says
 * `termsRequired: true` - a Google sign-in with no acceptance on file. The
 * shell's gate reads `GET /api/account/terms` ONLY while this is present, so a
 * password sign-in never pays for a read.
 *
 * ⚠ The session's own lifetime, not the browser's (Backend's catch): a marker
 *   that died with the browser would let a person close it on the Terms
 *   screen, come back still signed in, and walk past. It ends on a 200 from
 *   accept, on sign-out, or with the session.
 * ⚠ Not a security control - consent capture (Supervisor). If the sign-in
 *   record itself failed, there is no marker and the person goes in.
 */
export const TERMS_PENDING_COOKIE = 'gotcha_terms_pending';

export function termsPendingCookieOptions(): ReturnType<typeof sessionCookieOptions> {
  return { ...sessionCookieOptions(), name: TERMS_PENDING_COOKIE };
}
