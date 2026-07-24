/**
 * Narrow, first-party cookie codec for the opaque session identifier.
 *
 * NOT an auth system - it only parses a Cookie header to extract the one
 * session cookie, and serializes a Set-Cookie for it. No framework/browser
 * dependency, never touches document.cookie, never reads or writes tokens.
 *
 * Deliberately strict: a duplicate session cookie, a malformed value, or a
 * control character is REJECTED (throws), never "pick the first" - ambiguity in
 * an auth cookie is a security problem, not something to paper over.
 */

export const PROD_SESSION_COOKIE_NAME = "__Host-gotcha_session";
export const DEV_SESSION_COOKIE_NAME = "gotcha_session_dev";

export class SessionCookieError extends Error {
  constructor(public readonly code: string) {
    super(`session cookie error: ${code}`);
    this.name = "SessionCookieError";
  }
}

// RFC6265 cookie-octet (value chars), minus the ones we never emit. We accept a
// slightly narrower set than the RFC since our value is always base64url.
const CONTROL_RE = /[\x00-\x1F\x7F]/;
const COOKIE_NAME_RE = /^[A-Za-z0-9!#$%&'*+._|~^`-]+$/; // token chars incl. __Host-

/**
 * Extract the value of `name` from a raw Cookie header.
 * Returns null when the cookie is simply absent.
 * Throws SessionCookieError on a duplicate name or a malformed/ambiguous value.
 */
export function parseSessionCookie(cookieHeader: string | undefined | null, name: string): string | null {
  if (!name || !COOKIE_NAME_RE.test(name)) throw new SessionCookieError("bad_name");
  if (cookieHeader == null || cookieHeader === "") return null;
  if (typeof cookieHeader !== "string" || CONTROL_RE.test(cookieHeader)) {
    throw new SessionCookieError("malformed_header");
  }

  const found: string[] = [];
  for (const pair of cookieHeader.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue; // attribute-less segment - not a name=value pair
    const k = pair.slice(0, eq).trim();
    if (k !== name) continue;
    let v = pair.slice(eq + 1).trim();
    // A quoted value is permitted by RFC6265; unwrap a single matched pair.
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    found.push(v);
  }

  if (found.length === 0) return null;
  if (found.length > 1) throw new SessionCookieError("duplicate"); // ambiguous - reject
  const value = found[0];
  if (value === "" || CONTROL_RE.test(value)) throw new SessionCookieError("malformed_value");
  return value;
}

export interface SessionCookieContract {
  name: string;
  secure: boolean;
  sameSite: "Lax" | "Strict" | "None";
  path: string;
  /** `__Host-` cookies MUST NOT set Domain - always undefined here. */
  domain?: undefined;
  httpOnly: true;
}

/**
 * Resolve the environment's cookie contract. Production MUST use a `__Host-`
 * name with Secure; the local-HTTP dev cookie uses a distinct non-`__Host-`
 * name and is REJECTED if it somehow reaches production. The production cookie
 * is never weakened to accommodate localhost.
 */
export function resolveSessionCookieContract(env: NodeJS.ProcessEnv = process.env): SessionCookieContract {
  const isProd = env.NODE_ENV === "production";
  const configuredName = env.SESSION_COOKIE_NAME?.trim();
  const name = configuredName || (isProd ? PROD_SESSION_COOKIE_NAME : DEV_SESSION_COOKIE_NAME);
  const isHostPrefixed = name.startsWith("__Host-");
  // SESSION_COOKIE_SECURE overrides only DOWN in non-prod; prod is always secure.
  const secure = isProd ? true : env.SESSION_COOKIE_SECURE === "true";

  if (isProd) {
    if (!isHostPrefixed) throw new SessionCookieError("prod_requires_host_prefix");
    if (!secure) throw new SessionCookieError("prod_requires_secure");
  }
  // A __Host- cookie is only valid when Secure + Path=/ + no Domain, in any env.
  if (isHostPrefixed && !secure) throw new SessionCookieError("host_prefix_requires_secure");

  return { name, secure, sameSite: "Lax", path: "/", domain: undefined, httpOnly: true };
}

export interface SerializeOpts {
  maxAgeSeconds: number;
  /** Override the resolved contract (tests / explicit control). */
  contract?: SessionCookieContract;
  env?: NodeJS.ProcessEnv;
}

/** Serialize the Set-Cookie header for the session cookie. */
export function serializeSessionCookie(value: string, opts: SerializeOpts): string {
  const contract = opts.contract || resolveSessionCookieContract(opts.env);
  if (typeof value !== "string" || value === "" || CONTROL_RE.test(value) || value.includes(";")) {
    throw new SessionCookieError("bad_value");
  }
  if (contract.name.startsWith("__Host-")) {
    // Invariants enforced, not assumed.
    if (!contract.secure) throw new SessionCookieError("host_prefix_requires_secure");
    if (contract.path !== "/") throw new SessionCookieError("host_prefix_requires_root_path");
    if (contract.domain !== undefined) throw new SessionCookieError("host_prefix_forbids_domain");
  }
  if (!Number.isFinite(opts.maxAgeSeconds) || opts.maxAgeSeconds < 0) {
    throw new SessionCookieError("bad_max_age");
  }

  const parts = [`${contract.name}=${value}`, `Path=${contract.path}`, `Max-Age=${Math.floor(opts.maxAgeSeconds)}`];
  if (contract.httpOnly) parts.push("HttpOnly");
  if (contract.secure) parts.push("Secure");
  parts.push(`SameSite=${contract.sameSite}`);
  // Deliberately NO Domain attribute (required by the __Host- prefix).
  return parts.join("; ");
}

/** Set-Cookie that clears the session cookie (logout / revocation). */
export function serializeClearedSessionCookie(env: NodeJS.ProcessEnv = process.env): string {
  const contract = resolveSessionCookieContract(env);
  const parts = [`${contract.name}=`, `Path=${contract.path}`, "Max-Age=0", "HttpOnly"];
  if (contract.secure) parts.push("Secure");
  parts.push(`SameSite=${contract.sameSite}`);
  return parts.join("; ");
}
