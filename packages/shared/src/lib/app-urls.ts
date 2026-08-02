/**
 * The one place a public GOTCHA URL is built.
 *
 * Five hostnames, five jobs, and they are not interchangeable:
 *
 *   gotcha.co.il        marketing only - anonymous pages, pricing, links INTO the app
 *   app.gotcha.co.il    the authenticated application, its API, OAuth callbacks, webhooks
 *   auth.gotcha.co.il   Authentik only - login, MFA, reset, verification
 *   help.gotcha.co.il   Help Center only
 *   voice.gotcha.co.il  voice service only
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * Before this, a public URL was built from whichever of FRONTEND_URL,
 * DASHBOARD_URL, APP_ORIGIN, APP_PUBLIC_URL or PUBLIC_BASE_URL a given file
 * happened to reach for, and every one of them fell back to a literal. Twenty
 * call sites built customer-facing links as:
 *
 *     process.env.FRONTEND_URL || "http://localhost:3000"
 *
 * That is not a development convenience in a service that sends email. With
 * FRONTEND_URL unset in production, tenant invitations, password-created
 * links, approval links and notification deep links all point at localhost -
 * and nothing fails, nothing logs, and the first person to find out is a
 * customer who cannot open the link they were sent. One site
 * (`onboarding.ts`) fell back to `https://gotcha.co.il`, sending an
 * authenticated user to the marketing site instead.
 *
 * So the rules here are deliberate:
 *
 *   A missing value is an error, not a localhost. In production this throws at
 *   startup rather than quietly generating links nobody can use. Locally it
 *   defaults, because refusing to boot a dev stack helps nobody.
 *
 *   The origin is never caller-supplied. Every helper takes a PATH. There is
 *   no input through which a request body can change the hostname, which is
 *   what stops a "returnTo" becoming an open redirect carrying our brand.
 *
 *   Marketing and application are separate functions, so sending an
 *   authenticated user to the marketing site has to be a decision somebody
 *   typed, not a fallback they inherited.
 */

/** The distinct public roles this deployment serves. */
export type PublicSurface = "app" | "marketing" | "auth" | "help" | "voice";

interface SurfaceSpec {
  /** Canonical env var. */
  env: string;
  /** Older vars still honoured, in priority order. */
  legacy: string[];
  /** Development-only default. Never used when NODE_ENV=production. */
  devDefault: string;
  /** Whether an unset value is fatal in production. */
  requiredInProduction: boolean;
}

const SURFACES: Record<PublicSurface, SurfaceSpec> = {
  // The application is required: everything authenticated links back to it.
  app: {
    env: "PUBLIC_APP_URL",
    // APP_ORIGIN drives the CSRF/CORS allow-list and APP_PUBLIC_URL drives
    // payment returns. Both already mean "the application origin", so they are
    // read rather than duplicated - one deployment should not be able to
    // disagree with itself about where the app lives.
    legacy: ["APP_ORIGIN", "APP_PUBLIC_URL", "FRONTEND_URL"],
    devDefault: "http://localhost:3000",
    requiredInProduction: true,
  },
  marketing: {
    env: "PUBLIC_MARKETING_URL",
    legacy: [],
    devDefault: "http://localhost:3000",
    // Not fatal: a deployment that never links out to marketing is legitimate.
    requiredInProduction: false,
  },
  auth: {
    env: "PUBLIC_AUTH_URL",
    legacy: ["AUTHENTIK_URL"],
    devDefault: "http://localhost:9000",
    requiredInProduction: true,
  },
  help: {
    env: "PUBLIC_HELP_URL",
    legacy: [],
    devDefault: "http://localhost:4321",
    requiredInProduction: false,
  },
  voice: {
    env: "PUBLIC_VOICE_URL",
    legacy: ["VOICE_PUBLIC_URL"],
    devDefault: "http://localhost:4007",
    requiredInProduction: false,
  },
};

export class PublicUrlError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "PublicUrlError";
  }
}

/**
 * Validate and normalise one origin.
 *
 * Returns `scheme://host[:port]` with no trailing slash. Rejects anything that
 * is not a bare absolute origin - a value carrying a path, a query, credentials
 * or a wildcard is a configuration mistake, and accepting it here would move the
 * mistake somewhere harder to see.
 */
export function normalisePublicOrigin(raw: string, label: string, isProd: boolean): string {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) throw new PublicUrlError("unset", `${label} is not set`);
  if (trimmed.includes("*")) throw new PublicUrlError("wildcard", `${label} must not contain a wildcard`);

  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    throw new PublicUrlError("malformed", `${label} is not a URL: ${JSON.stringify(trimmed)}`);
  }

  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new PublicUrlError("scheme", `${label} must be http or https, got ${u.protocol}`);
  }
  // http is tolerable on a laptop and nowhere else. These origins end up in
  // OAuth redirect allow-lists and in email a customer clicks.
  if (isProd && u.protocol !== "https:") {
    throw new PublicUrlError("insecure", `${label} must be https in production`);
  }
  if (u.username || u.password) {
    throw new PublicUrlError("credentials", `${label} must not carry credentials`);
  }
  if ((u.pathname && u.pathname !== "/") || u.search || u.hash) {
    throw new PublicUrlError(
      "not_bare_origin",
      `${label} must be a bare origin with no path or query, got ${JSON.stringify(trimmed)}`,
    );
  }

  const defaultPort = u.protocol === "https:" ? "443" : "80";
  const port = u.port && u.port !== defaultPort ? `:${u.port}` : "";
  return `${u.protocol}//${u.hostname.toLowerCase()}${port}`;
}

/**
 * Resolve one surface's origin.
 *
 * Production never falls back to a development default. That is the whole
 * point: a deployment missing PUBLIC_APP_URL should fail loudly at boot, not
 * mail localhost links to customers for a week.
 */
export function publicOrigin(
  surface: PublicSurface,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const spec = SURFACES[surface];
  const isProd = env.NODE_ENV === "production";

  const candidates = [spec.env, ...spec.legacy];
  for (const name of candidates) {
    const raw = env[name];
    if (raw && String(raw).trim()) {
      return normalisePublicOrigin(String(raw), name, isProd);
    }
  }

  if (isProd && spec.requiredInProduction) {
    throw new PublicUrlError(
      "required",
      `${spec.env} must be set in production (checked: ${candidates.join(", ")})`,
    );
  }
  if (isProd) {
    // Optional in production, but a development default must never leak into
    // it - a help link to localhost in a customer email is still a broken link.
    throw new PublicUrlError(
      "required",
      `${spec.env} is not set; refusing to fall back to ${spec.devDefault} in production`,
    );
  }
  return normalisePublicOrigin(spec.devDefault, spec.env, false);
}

/**
 * Join a path onto a surface origin.
 *
 * Takes a PATH and only a path. Anything trying to become an origin - a scheme,
 * a protocol-relative `//host` - is rejected rather than sanitised, because
 * sanitising this class of input is how the interesting cases get through.
 */
export function publicUrl(
  surface: PublicSurface,
  path = "/",
  params: Record<string, string | number | boolean> = {},
  env: NodeJS.ProcessEnv = process.env,
): string {
  const origin = publicOrigin(surface, env);

  const p = String(path ?? "/");
  if (!p.startsWith("/")) {
    throw new PublicUrlError("relative_path", `path must start with "/", got ${JSON.stringify(p)}`);
  }
  if (p.startsWith("//")) {
    throw new PublicUrlError("protocol_relative", `path must not be protocol-relative: ${JSON.stringify(p)}`);
  }
  if (/^\/[a-z][a-z0-9+.-]*:/i.test(p) || /^[a-z][a-z0-9+.-]*:/i.test(p)) {
    throw new PublicUrlError("scheme_in_path", `path must not carry a scheme: ${JSON.stringify(p)}`);
  }

  const url = new URL(origin + p);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  // Belt and braces. If anything above ever let an origin through, this catches
  // it before the URL reaches an email, a provider, or a browser redirect.
  if (url.origin !== origin) {
    throw new PublicUrlError("off_origin", `refusing to build a URL off-origin: ${url.origin}`);
  }
  return url.toString();
}

/** The authenticated application. Use this for anything a signed-in user opens. */
export const appUrl = (path?: string, params?: Record<string, string | number | boolean>) =>
  publicUrl("app", path, params);

/** The marketing site. Only for genuinely anonymous destinations. */
export const marketingUrl = (path?: string, params?: Record<string, string | number | boolean>) =>
  publicUrl("marketing", path, params);

/** Authentik. Login, logout, MFA, reset, verification - nothing else. */
export const authUrl = (path?: string, params?: Record<string, string | number | boolean>) =>
  publicUrl("auth", path, params);

/** The Help Center. */
export const helpUrl = (path?: string, params?: Record<string, string | number | boolean>) =>
  publicUrl("help", path, params);

/** The voice service. Never an application OAuth or webhook target. */
export const voiceUrl = (path?: string, params?: Record<string, string | number | boolean>) =>
  publicUrl("voice", path, params);

/**
 * An OAuth redirect URI owned by the application.
 *
 * Always built from the app origin, never from a request Host and never from a
 * provider-supplied value. A redirect_uri that can be influenced by the request
 * is the classic way an OAuth code gets delivered to somebody else.
 */
export function oauthRedirectUri(path: string, env: NodeJS.ProcessEnv = process.env): string {
  return publicUrl("app", path, {}, env);
}

/**
 * A webhook URL this deployment publishes to a provider.
 *
 * Distinct from `oauthRedirectUri` even though both currently resolve to the
 * app origin, because they are different things with different migration
 * rules: a redirect URI is validated against an allow-list the provider holds,
 * while a webhook URL is a delivery destination with retries and signatures
 * behind it. Conflating them is how a domain migration drops events.
 */
export function webhookUrl(path: string, env: NodeJS.ProcessEnv = process.env): string {
  return publicUrl("app", path, {}, env);
}

export interface PublicUrlDiagnostics {
  surface: PublicSurface;
  origin: string | null;
  source: string | null;
  error: string | null;
}

/**
 * Resolve every surface for logging at startup.
 *
 * Origins are public by definition - they appear in browser address bars and in
 * provider dashboards - so printing them leaks nothing. No env VALUE other than
 * the origin itself is read or reported.
 */
export function publicUrlDiagnostics(env: NodeJS.ProcessEnv = process.env): PublicUrlDiagnostics[] {
  return (Object.keys(SURFACES) as PublicSurface[]).map((surface) => {
    const spec = SURFACES[surface];
    const source = [spec.env, ...spec.legacy].find((n) => env[n] && String(env[n]).trim()) ?? null;
    try {
      return { surface, origin: publicOrigin(surface, env), source: source ?? "(dev default)", error: null };
    } catch (err: any) {
      return { surface, origin: null, source, error: err?.message ?? "unresolved" };
    }
  });
}

/**
 * Fail startup when a required public origin is missing or wrong.
 *
 * Called from service bootstrap. Deliberately fatal: the alternative is a
 * service that starts cleanly and then emails links nobody can open.
 */
export function assertPublicUrlsReady(env: NodeJS.ProcessEnv = process.env): void {
  const problems: string[] = [];
  for (const surface of Object.keys(SURFACES) as PublicSurface[]) {
    const spec = SURFACES[surface];
    if (!spec.requiredInProduction && env.NODE_ENV !== "production") continue;
    try {
      publicOrigin(surface, env);
    } catch (err: any) {
      if (spec.requiredInProduction) problems.push(err?.message ?? `${spec.env} unresolved`);
    }
  }
  if (problems.length) {
    throw new PublicUrlError("startup", `public URL configuration is unusable:\n  - ${problems.join("\n  - ")}`);
  }
}
