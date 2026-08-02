/**
 * Environment-backed application-origin policy for the BFF cookie model.
 *
 * The production application host is NEVER hardcoded or guessed - it comes from
 * APP_ORIGIN, with additional allowed origins (CSRF Origin allow-list, future
 * credentialed CORS) from AUTH_ALLOWED_ORIGINS. Matching is EXACT on normalized
 * origins: scheme + host + non-default port. No wildcards, no suffix/substring/
 * endsWith checks (which is how `evil-gotcha.co.il.attacker.com` slips past a
 * naive `endsWith("gotcha.co.il")`).
 */

export class AppOriginError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message || `app origin error: ${code}`);
    this.name = "AppOriginError";
  }
}

/**
 * Normalize to `scheme://host[:port]` - lowercased scheme+host, port omitted
 * when it is the scheme default, no path/query/fragment, no trailing slash.
 * Throws on anything that is not a plain absolute origin.
 */
export function normalizeOrigin(input: string): string {
  if (typeof input !== "string" || input.trim() === "" || input.includes("*")) {
    throw new AppOriginError("invalid_origin");
  }
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new AppOriginError("invalid_origin");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new AppOriginError("invalid_scheme");
  }
  // A bare origin has no path/query/fragment and no credentials.
  if ((u.pathname && u.pathname !== "/") || u.search || u.hash || u.username || u.password) {
    throw new AppOriginError("not_bare_origin");
  }
  const defaultPort = u.protocol === "https:" ? "443" : "80";
  const port = u.port && u.port !== defaultPort ? `:${u.port}` : "";
  return `${u.protocol}//${u.hostname.toLowerCase()}${port}`;
}

export interface OriginPolicy {
  appOrigin: string | null;
  allowed: Set<string>; // normalized origins, exact match
}

/**
 * Build the policy from the environment. Production FAILS if APP_ORIGIN is
 * absent or invalid, or must be https. dev.gotcha.co.il / preview / localhost
 * are only ever present when explicitly configured for that environment.
 */
export function loadOriginPolicy(env: NodeJS.ProcessEnv = process.env): OriginPolicy {
  const isProd = env.NODE_ENV === "production";
  const rawApp = env.APP_ORIGIN?.trim();

  let appOrigin: string | null = null;
  if (rawApp) {
    appOrigin = normalizeOrigin(rawApp); // throws on invalid/wildcard
    if (isProd && !appOrigin.startsWith("https://")) {
      throw new AppOriginError("prod_requires_https");
    }
  } else if (isProd) {
    throw new AppOriginError("app_origin_required_in_production");
  }

  const allowed = new Set<string>();
  if (appOrigin) allowed.add(appOrigin);
  const extra = env.AUTH_ALLOWED_ORIGINS?.trim();
  if (extra) {
    for (const part of extra.split(",")) {
      const p = part.trim();
      if (p) allowed.add(normalizeOrigin(p)); // throws on wildcard/invalid
    }
  }
  return { appOrigin, allowed };
}

/** Exact membership test. NEVER endsWith/substring. */
export function isAllowedOrigin(origin: string, policy: OriginPolicy): boolean {
  let normalized: string;
  try {
    normalized = normalizeOrigin(origin);
  } catch {
    return false;
  }
  return policy.allowed.has(normalized);
}

/** Startup guard - validates APP_ORIGIN/AUTH_ALLOWED_ORIGINS parse & prod rules. */
export function assertAppOriginReady(env: NodeJS.ProcessEnv = process.env): void {
  loadOriginPolicy(env);
}
