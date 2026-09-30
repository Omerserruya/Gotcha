import 'server-only';

import { CompactEncrypt, compactDecrypt } from 'jose';
import { z } from 'zod';

import { serverEnv } from '@/config/env.server';
import { appPath } from '@/lib/base-path';
import { safeInternalPath } from '@/lib/safe-url';

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
  /*
   * OpenID Connect `nonce`, matched against the ID Token's claim at exchange.
   *
   * ★ PKCE binds the CODE to this client; the nonce binds the ID TOKEN to
   *   this sign-in. They are different objects and a stolen token replayed
   *   into a fresh exchange is what the second one refuses.
   *
   * ⚠ OPTIONAL, AND DELIBERATELY SO. A cookie sealed by a build that did not
   *   send a nonce must still complete — those sign-ins are in flight across
   *   a deploy, and failing them would log people out for the length of a
   *   restart. `openid-client` is symmetric here: no nonce sent means no
   *   nonce claimed means none expected.
   */
  n: z.string().min(1).optional(),
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
 * Without this an attacker can turn the login endpoint into an open redirect by
 * handing a victim `/api/auth/login?returnTo=https://evil.example`: they sign in
 * legitimately, on our real sign-in page, and land somewhere else.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THIS HELD ITS OWN COPY OF THE CHECK, AND ITS OWN COPY OF THE HOLE
 * ════════════════════════════════════════════════════════════════════════════
 * It used to be three string checks — must start with `/`, not `//`, not `/\`.
 * `safeInternalPath` in `lib/safe-url.ts` was the same three lines, and a tab
 * walks through both: **the URL parser strips tab, LF and CR from anywhere in a
 * URL before it parses**, so `"/\t/evil.example"` satisfies every check and
 * then becomes `//evil.example`. Measured, not reasoned.
 *
 * ★ **THIS SINK WAS NEVER THE REACHABLE ONE, AND MY FIRST ACCOUNT OF WHY WAS
 *   WRONG.** I wrote that the `/v2` prefix was hiding it and that a
 *   root-mounted build would expose it. Measured at both mount points, the
 *   callback is safe at both:
 *
 *       BASE_PATH="/v2"  ->  https://app/v2//evil.example   on-site
 *       BASE_PATH=""     ->  https://app//evil.example      on-site
 *
 *   `appUrl` CONCATENATES — `${origin}${BASE_PATH}${path}` — so the authority
 *   is already fixed before the candidate is appended and there is no
 *   authority position left to smuggle into. The prefix was not the
 *   protection; the composition was.
 *
 *   The live sink was the other one: `safeInternalPath` feeding an `href`,
 *   which the **browser** resolves against the document, with no prefix in
 *   front of it at all. Same hole, same day, and the half I could not reach
 *   from here was the half that mattered.
 *
 * ★ So this function is fixed because the predicate was wrong, not because
 *   this caller was exploitable. Both are worth saying; only one of them was
 *   urgent.
 *
 * The predicate now lives in one place. This differs only in what it says when
 * the answer is no: a rejected link renders nothing, a rejected return path
 * sends somebody to the top of the app rather than nowhere.
 */
export function safeReturnPath(candidate: string | null | undefined): string {
  return safeInternalPath(candidate) ?? '/';
}
