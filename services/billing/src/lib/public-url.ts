/**
 * The one place a customer-facing URL is built.
 *
 * These URLs are handed to a payment provider, which puts them in front of a
 * customer mid-payment. Three things follow from that, and all three used to be
 * left to whatever the environment happened to contain:
 *
 *   A missing value must not be silent. `returnUrl` previously returned
 *   undefined when APP_PUBLIC_URL was unset, so the customer was sent to a
 *   hosted payment page with nowhere to come back to - and the first anyone
 *   would know is a customer stranded on iCount's page after paying.
 *
 *   The destination must be OURS. The page a customer returns to after paying
 *   is a natural thing to make configurable per-request, and a natural
 *   open-redirect: a caller-supplied return URL sent to a payment page is a
 *   phishing target with our brand on it. Only a path is ever accepted here,
 *   and the origin always comes from configuration.
 *
 *   It must be https in production. A payment return over http is an
 *   opportunity to intercept someone mid-checkout.
 */

/** Hosts this deployment is allowed to send customers to. */
function allowedHosts(): string[] {
  return String(process.env.APP_PUBLIC_URL_ALLOWED_HOSTS || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

export class PublicUrlMisconfigured extends Error {
  constructor(message: string) {
    super(`[billing] APP_PUBLIC_URL ${message}`);
    this.name = "PublicUrlMisconfigured";
  }
}

/**
 * The configured public origin, validated.
 *
 * Returns the origin with no trailing slash, or throws. Never returns a
 * half-usable value - a URL a customer cannot come back through is not better
 * than an error at startup.
 */
export function appPublicUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = String(env.APP_PUBLIC_URL || "").trim();
  if (!raw) throw new PublicUrlMisconfigured("is not set");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PublicUrlMisconfigured(`is not a URL: ${JSON.stringify(raw)}`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new PublicUrlMisconfigured(`must be http or https, got ${url.protocol}`);
  }

  // http is tolerable locally and nowhere else. A payment return over http is
  // an opportunity to intercept someone in the middle of paying.
  if (env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new PublicUrlMisconfigured("must be https in production");
  }

  if (url.username || url.password) {
    throw new PublicUrlMisconfigured("must not carry credentials");
  }

  const hosts = allowedHosts();
  if (hosts.length > 0 && !hosts.includes(url.hostname.toLowerCase())) {
    throw new PublicUrlMisconfigured(
      `host ${url.hostname} is not in APP_PUBLIC_URL_ALLOWED_HOSTS (${hosts.join(", ")})`,
    );
  }

  return url.origin;
}

/**
 * Build a URL a customer returns to.
 *
 * Takes a PATH, never a URL. That is the whole defence against an open
 * redirect: there is no input through which a caller can change the origin, so
 * a value that reached here from a request body still cannot send anyone off
 * our domain.
 */
export function buildReturnUrl(path: string, params: Record<string, string> = {}): string {
  const origin = appPublicUrl();

  // A path, and only a path. Anything that looks like it is trying to become an
  // origin - a scheme, a protocol-relative "//host" - is rejected rather than
  // sanitized, because sanitizing this kind of input is how the interesting
  // cases get through.
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new PublicUrlMisconfigured(`return path must be a single-slash path, got ${JSON.stringify(path)}`);
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
    throw new PublicUrlMisconfigured(`return path must not carry a scheme: ${JSON.stringify(path)}`);
  }

  const url = new URL(origin + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  // Belt and braces: if anything above ever let an origin through, this catches
  // it before the URL reaches a payment provider.
  if (url.origin !== origin) {
    throw new PublicUrlMisconfigured(`refusing to build a URL off-origin: ${url.origin}`);
  }
  return url.toString();
}

/**
 * Refuse to start without a usable public URL when payments are switched on.
 *
 * Deliberately conditional. A stack with every payment capability off never
 * sends anyone to a payment page, and demanding this of it would block
 * development for no benefit. The moment one is enabled, the value stops being
 * optional.
 */
export function assertPublicUrlConfigured(env: NodeJS.ProcessEnv = process.env): void {
  const paymentsOn = [
    "ICOUNT_CHECKOUT_ENABLED",
    "ICOUNT_TOKENIZATION_ENABLED",
    "ICOUNT_STORED_CARD_CHARGE_ENABLED",
    "SELF_SERVE_CHECKOUT_ENABLED",
  ].some((v) => String(env[v] || "").trim().toLowerCase() === "true");

  if (!paymentsOn) return;
  // Throws with the specific reason.
  appPublicUrl(env);
}
