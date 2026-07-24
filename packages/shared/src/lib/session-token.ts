import crypto from "crypto";

/**
 * The opaque session identifier carried in the HttpOnly cookie.
 *
 * Lookup path (never the raw value in the DB):
 *   cookie value  ->  hashSessionToken()  ->  indexed UserSession.sessionTokenHash
 *
 * The raw token is high-entropy random (256 bits), so a plain SHA-256 hash is a
 * sufficient, deterministic index key - the same pattern used for API keys.
 * The raw value is never persisted and must never be logged.
 */

const TOKEN_BYTES = 32; // 256 bits of entropy - well above the 128-bit floor
// base64url of 32 bytes is 43 chars (no padding). Charset is [A-Za-z0-9_-].
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

/** Generate a fresh cryptographically-random opaque session token. */
export function generateSessionToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

/** Shape check for a token received from a cookie (does not prove validity). */
export function isWellFormedSessionToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_RE.test(value);
}

/**
 * Deterministic hash for the DB lookup key. Domain-separated so this hash can
 * never coincide with an unrelated SHA-256 of the same bytes elsewhere.
 * Rejects a malformed token rather than hashing arbitrary input.
 */
export function hashSessionToken(token: string): string {
  if (!isWellFormedSessionToken(token)) {
    throw new Error("hashSessionToken: malformed session token");
  }
  return crypto
    .createHash("sha256")
    .update("gotcha.session.v1:")
    .update(token)
    .digest("hex");
}

export function isWellFormedTokenHash(value: unknown): value is string {
  return typeof value === "string" && HASH_RE.test(value);
}

export const __SESSION_TOKEN_INTERNALS__ = { TOKEN_BYTES, TOKEN_RE, HASH_RE };
