import 'server-only';

import { CompactEncrypt, compactDecrypt } from 'jose';
import { z } from 'zod';

import { serverEnv } from '@/config/env.server';

/**
 * The short-lived state carried across the redirect to Authentik and back.
 *
 * It holds the PKCE verifier, the CSRF `state` value and where to land the
 * user afterwards. Encrypted in its own cookie rather than kept server-side,
 * so the app stays stateless and horizontally scalable.
 */
const loginStateSchema = z.object({
  /** PKCE `code_verifier`. */
  v: z.string().min(1),
  /** OAuth `state`, matched on return to defeat CSRF on the callback. */
  s: z.string().min(1),
  /** Same-origin path to return to. Validated before use. */
  r: z.string().default('/'),
});

export type LoginState = z.infer<typeof loginStateSchema>;

export const LOGIN_STATE_COOKIE = 'gotcha_login';
/** The user has ten minutes to finish signing in. */
export const LOGIN_STATE_MAX_AGE_SECONDS = 600;

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

export async function sealLoginState(state: LoginState): Promise<string> {
  return new CompactEncrypt(new TextEncoder().encode(JSON.stringify(state)))
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .encrypt(await key());
}

export async function unsealLoginState(sealed: string | undefined): Promise<LoginState | null> {
  if (!sealed) return null;
  try {
    const { plaintext } = await compactDecrypt(sealed, await key());
    const parsed = loginStateSchema.safeParse(JSON.parse(new TextDecoder().decode(plaintext)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Constrains a post-login redirect to this application.
 *
 * Without this an attacker can turn the login endpoint into an open redirect
 * by handing a victim `/api/auth/login?returnTo=https://evil.example`. Only a
 * single-slash-prefixed relative path is accepted; `//host` and any absolute
 * URL are rejected.
 */
export function safeReturnPath(candidate: string | null | undefined): string {
  if (!candidate) return '/';
  if (!candidate.startsWith('/')) return '/';
  if (candidate.startsWith('//')) return '/';
  if (candidate.startsWith('/\\')) return '/';
  return candidate;
}
