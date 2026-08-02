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

/**
 * The public origin of the application itself (app.gotcha.co.il).
 *
 * Every customer- and operator-facing link the backend generates - invite
 * links, password-setup links, notification emails, OAuth "back to the app"
 * redirects - is built from this. Nineteen call sites used to inline their own
 * fallback, and the fallbacks disagreed: some produced `http://localhost:3000`,
 * one produced `https://gotcha.co.il`, which is the MARKETING host and does not
 * serve authenticated routes.
 *
 * Neither is a safe production default, and both fail quietly: the email sends,
 * the link renders, and the recipient lands somewhere that cannot log them in.
 * So in production a missing FRONTEND_URL throws.
 */
export function resolveAppPublicUrl(env: NodeJS.ProcessEnv = process.env): string {
  const isProd = env.NODE_ENV === "production";
  const raw = env.FRONTEND_URL?.trim() || env.DASHBOARD_URL?.trim();

  if (raw) {
    const origin = normalizeOrigin(raw); // throws on wildcard/path/invalid
    if (isProd && !origin.startsWith("https://")) {
      throw new AppOriginError("app_prod_requires_https");
    }
    return origin;
  }

  if (isProd) throw new AppOriginError("frontend_url_required_in_production");
  return normalizeOrigin("http://localhost:3000");
}

/** Startup guard - fail the boot, not the first email. */
export function assertAppPublicUrlReady(env: NodeJS.ProcessEnv = process.env): void {
  resolveAppPublicUrl(env);
}

/**
 * The public origin Twilio talks to, which is NOT the application origin.
 *
 * Voice is a separate hostname on purpose. The Cloudflare Tunnel routes
 * voice.gotcha.co.il straight at the voice-copilot container, skipping the
 * gateway, because Twilio Media Streams are a long-lived WebSocket and every
 * proxy hop in front of one is latency on a live call.
 *
 * It used to be derived from PUBLIC_BASE_URL - the same variable the
 * application uses - which meant the two could never diverge, and pointing the
 * app at app.gotcha.co.il silently moved every Twilio callback there too. So
 * this reads its own variable and, in production, refuses to guess:
 *
 *   - a missing value throws rather than falling back to the app origin, to
 *     localhost, or to the marketing host. A Twilio webhook pointed at the
 *     wrong host does not fail loudly - the call simply goes silent, which is
 *     the worst way to discover a configuration mistake.
 *   - http is refused. Twilio will not open a wss:// media stream against an
 *     origin we advertised over http.
 *
 * Outside production the app origin (or localhost) is an acceptable fallback,
 * because a dev stack runs every service behind one gateway.
 */
export function resolveVoicePublicUrl(env: NodeJS.ProcessEnv = process.env): string {
  const isProd = env.NODE_ENV === "production";
  const raw = env.VOICE_PUBLIC_URL?.trim();

  if (raw) {
    const origin = normalizeOrigin(raw); // throws on wildcard/path/invalid
    if (isProd && !origin.startsWith("https://")) {
      throw new AppOriginError("voice_prod_requires_https");
    }
    return origin;
  }

  if (isProd) throw new AppOriginError("voice_public_url_required_in_production");

  // Dev only: one gateway fronts everything, so the app origin is correct.
  const fallback = env.PUBLIC_BASE_URL?.trim() || "http://localhost";
  return normalizeOrigin(fallback);
}

/** Startup guard - call before the service accepts a call. */
export function assertVoicePublicUrlReady(env: NodeJS.ProcessEnv = process.env): void {
  resolveVoicePublicUrl(env);
}
