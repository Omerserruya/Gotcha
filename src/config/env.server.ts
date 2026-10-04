import 'server-only';

import { z } from 'zod';

import { APP_ENVIRONMENTS } from './app-env';
import { emptyIsUnset } from './empty-is-unset';

/**
 * Server-only configuration.
 *
 * These values never reach the browser bundle. `server-only` makes an
 * accidental client import a build error rather than a leaked secret.
 *
 * Everything here is validated once, at first access, and the process fails
 * loudly on a bad configuration instead of producing a subtly broken app.
 */
const serverEnvSchema = z.object({
  APP_ENV: z.enum(APP_ENVIRONMENTS).default('local'),

  /**
   * Origin of the GOTCHA platform API for server-to-server calls.
   * The browser never sees this: all browser traffic is proxied through the
   * Next.js BFF, because the platform API only allows its own origin via CORS.
   */
  API_BASE_URL: z.url(),

  /** Upper bound on a single upstream API request, in milliseconds. */
  API_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(20_000),

  /**
   * The platform's own session cookie.
   *
   * When the app is served from a host that shares the cookie's domain, the
   * browser sends this cookie to us as well, and the BFF can forward it
   * upstream instead of attaching a bearer token of its own. That is the
   * intended architecture: the platform issues the session, the frontend never
   * holds a token, and revoking the session takes effect everywhere at once.
   *
   * Unset means the app runs on its own session instead — see `src/auth`.
   */
  PLATFORM_SESSION_COOKIE: z.string().min(1).optional(),

  /**
   * Where sign-in begins.
   *
   * Set to the platform's own login route to hand the whole OIDC flow to it.
   * Unset means this app drives Authorization Code + PKCE itself.
   */
  PLATFORM_LOGIN_URL: z.url().optional(),

  /**
   * 01c's "Book a setup call" (Omer, decision 01): where it books. Unset, the
   * link is not drawn — never a call booked nowhere.
   */
  SETUP_CALL_URL: z.url().optional(),

  /**
   * Where the sign-in panel hands over once the flow is complete, when that is
   * not this same deployment.
   *
   * ═════════════════════════════════════════════════════════════════════════════
   * ★★ UNSET IS THE WHOLE PRODUCT TODAY, AND THE ONLY REASON THIS EXISTS IS
   *    THAT A SEPARATE AUTH ORIGIN BREAKS THE RELATIVE PATH
   * ═════════════════════════════════════════════════════════════════════════════
   * The panel finishes the flow and then navigates to `/api/auth/login` so the
   * OIDC exchange can run against the session it just created. Unset, that is
   * built with `appPath` and is a path on this same host — correct, and what
   * ships today.
   *
   * ★ Served from an auth origin it is NOT correct, and it fails in the
   *   confusing direction: the credentials are accepted, the identity provider
   *   session is created, and the browser then asks the AUTH host for a route
   *   only the product host has. Under a gateway allowlist that is a 404 at
   *   the end of a successful sign-in — a failure that looks like the panel
   *   is broken when the panel has just done its job.
   *
   * ★ And `appUrl(…, APP_ORIGIN)` cannot substitute. It rebuilds the path from
   *   this build’s own `BASE_PATH`, which on a root-mounted auth build is
   *   empty, so it would produce the product’s origin with the product’s mount
   *   point missing. The whole URL has to be given, not composed.
   */
  PRODUCT_LOGIN_URL: z.url().optional(),

  // --- Authentik OIDC (Authorization Code + PKCE, driven by the BFF) ---
  OIDC_ISSUER: z.url(),
  OIDC_CLIENT_ID: z.string().min(1),
  /** Omitted for a public client; present for a confidential one. */
  OIDC_CLIENT_SECRET: z.string().min(1).optional(),
  OIDC_SCOPES: z.string().min(1).default('openid profile email offline_access'),
  /** Absolute origin this app is reached at, used to build the redirect URI. */
  APP_ORIGIN: z.url(),

  /**
   * Key for the encrypted (JWE) session cookie. 32+ bytes of randomness.
   * Generate with: openssl rand -base64 48
   */
  SESSION_SECRET: z.string().min(32),
  SESSION_COOKIE_NAME: z.string().min(1).default('gotcha_session'),
  /** Absolute session lifetime in seconds. Default 30 days. */
  SESSION_MAX_AGE_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 24 * 30),

  // --- Observability ---
  SENTRY_DSN: z.string().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  SENTRY_RELEASE: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).optional(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | undefined;

/**
 * Reads and validates server configuration.
 *
 * Lazy rather than module-scope so that tooling which imports modules without a
 * full environment (lint, typecheck, some build steps) does not explode.
 */
export function serverEnv(): ServerEnv {
  if (cached) return cached;

  /*
   * ★★ EMPTY IS UNSET. A compose file's `${V2_OIDC_CLIENT_SECRET:-}` — the
   * documented way to make a variable optional — supplies an empty string,
   * and `z.string().min(1).optional()` rejects it. Every request reading the
   * server config then fails validation while pages that do not read it still
   * return 200: a container that looks healthy and whose login route 500s.
   */
  const parsed = serverEnvSchema.safeParse(emptyIsUnset({ ...process.env }));

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Invalid server environment configuration.\n${issues}\n\n` +
        'See .env.example for the full contract.',
    );
  }

  cached = parsed.data;
  return cached;
}

/** Test seam: forget the memoised configuration. */
export function resetServerEnvCache(): void {
  cached = undefined;
}
