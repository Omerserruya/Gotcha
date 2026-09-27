import 'server-only';

import { CompactEncrypt, compactDecrypt } from 'jose';
import { z } from 'zod';

import { serverEnv } from '@/config/env.server';
import { appPath } from '@/lib/base-path';

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

/**
 * Where the login-state cookie is scoped — and it must carry the base path.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THIS WAS HARDCODED `/api/auth` AND IT BROKE SIGN-IN UNDER `/v2`
 * ════════════════════════════════════════════════════════════════════════════
 * A cookie `Path` is not a URL this app emits — it is a constraint on which
 * URLs the **browser** will send the cookie to. Nothing in a redirect chain
 * reveals it: every `Location` header was right, the provider accepted the
 * redirect URI, credentials were accepted, and the callback still found no
 * state, because the browser declined to send a cookie scoped to `/api/auth`
 * to `/v2/api/auth/callback`. The result was `sign-in?error=expired` — a
 * failure that reads as a timeout.
 *
 * Found by walking a real browser, and **invisible to every instrument built
 * for this deployment**: the build-arg sweep checks args, the audit walks
 * redirect call sites, the config tests check env shapes. None of them can see
 * a cookie's scope.
 *
 * ── AND IT IS ONE CONSTANT BECAUSE THE SETTER AND THE DELETER MUST AGREE ──
 * `login/route.ts` sets it and `callback/route.ts` deletes it. A delete whose
 * path does not match the set is a no-op, which leaves a stale sealed state
 * that the next attempt may pick up — a failure that would come and go. They
 * read the same value from here rather than each writing a literal.
 *
 * Narrow rather than `/` on purpose: this cookie carries a PKCE verifier and
 * exists for one round trip, so it should not be attached to every request the
 * app makes. The session cookie is the opposite case and is scoped to `/`
 * deliberately — see `sessionCookieOptions`.
 */
export const LOGIN_STATE_COOKIE_PATH = appPath('/api/auth');
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
