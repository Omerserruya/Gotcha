import crypto from "crypto";

/**
 * Secret for signing third-party OAuth `state` parameters.
 *
 * This is NOT authentication. It is CSRF protection for OAuth round-trips to
 * CRMs, calendars, and channel providers: we sign a short-lived blob on the way
 * out and verify it on the way back, so a callback cannot be forged or replayed
 * into another tenant.
 *
 * It exists as its own secret because GOTCHA no longer has a JWT_SECRET - user
 * tokens are Authentik's and are verified via JWKS. These call sites used to
 * borrow JWT_SECRET and fall back to the literal "change-me" when it was
 * unset, which meant a missing env var silently made every integration's OAuth
 * state forgeable. Naming it for what it does keeps that from happening again.
 */
export function getOAuthStateSecret(): string {
  const v = process.env.OAUTH_STATE_SECRET;
  if (v && v.length >= 32) return v;

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "[oauth-state] OAUTH_STATE_SECRET is required in production (>=32 chars). " +
        "Refusing to sign OAuth state with a weak or default secret.",
    );
  }

  // Dev/test only: a random per-process secret. Signing still works within a
  // process, and any state signed by a previous boot correctly fails to
  // verify - which is exactly what an unconfigured deployment deserves, and is
  // far safer than a well-known constant.
  if (!devSecret) devSecret = crypto.randomBytes(32).toString("hex");
  return devSecret;
}

let devSecret: string | null = null;
