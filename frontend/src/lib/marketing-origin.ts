/**
 * Which of the two hostnames is this bundle being served from?
 *
 * There is ONE static export, and nginx serves it under two names:
 * gotcha.co.il (marketing) and app.gotcha.co.il (the application). A static
 * export cannot be built twice with different behaviour, so the split has to be
 * decided at runtime from the origin the browser actually loaded.
 *
 * Unset - dev, or any single-host deployment - means "no split": `/` keeps
 * rendering the landing page exactly as it always has, so running the frontend
 * on localhost still shows the marketing site. Only when a marketing origin is
 * configured does `/` on any OTHER host become an application root, where a
 * logged-out visitor is sent to sign in rather than shown a landing page that
 * belongs on the marketing domain.
 *
 * NEXT_PUBLIC_* is frozen at build time, so changing this requires a rebuild of
 * the gateway image - it is not readable from .env on the box.
 */
const CONFIGURED = (process.env.NEXT_PUBLIC_MARKETING_URL ?? "").trim();

/** Origin form, lowercased, or "" when the input is not a usable absolute URL. */
function normalizeOrigin(raw: string): string {
  if (!raw) return "";
  try {
    return new URL(raw).origin.toLowerCase();
  } catch {
    return "";
  }
}

/** The configured marketing origin, or "" when the split is not enabled. */
export const marketingOrigin = normalizeOrigin(CONFIGURED);

/**
 * True when `/` should render the marketing landing page on this origin.
 *
 * Fails OPEN on purpose: an unset or unparseable value renders marketing rather
 * than bouncing everyone to a login screen. A misconfiguration should degrade to
 * the behaviour that existed before this split, not lock visitors out of the
 * homepage.
 */
export function rendersMarketing(currentOrigin: string): boolean {
  if (!marketingOrigin) return true;
  return normalizeOrigin(currentOrigin) === marketingOrigin;
}

/**
 * True when the browser is on the MARKETING host of a configured split.
 *
 * Not the negation of rendersMarketing(): that one fails open and answers "may
 * `/` show the landing page here", which is also true on every host when no
 * split is configured. This answers "am I on the host that must NOT run
 * application flows", which is only ever true when a split actually exists.
 */
export function isMarketingHost(currentOrigin: string): boolean {
  if (!marketingOrigin) return false;
  return normalizeOrigin(currentOrigin) === marketingOrigin;
}

/**
 * The APPLICATION origin, derived from the OIDC callback rather than declared
 * separately.
 *
 * The two can never legitimately disagree: Authentik only ever returns a user
 * to a redirect_uri on its registered allow-list, so whichever origin owns
 * `/auth/callback` IS the application. Deriving it removes a second hostname
 * variable that could be set to something the IdP would reject - a mismatch
 * that does not fail at build time and only surfaces as a refused login.
 *
 * "" when unset (dev, single-host), which callers must treat as "no cross-host
 * hop to make" rather than guessing a hostname.
 */
export const appOrigin = normalizeOrigin(
  (process.env.NEXT_PUBLIC_OIDC_REDIRECT_URI ?? "").trim(),
);

/**
 * Where a "Log in" affordance should point from the page currently being shown.
 *
 * On the marketing host this is an ABSOLUTE url on the application host, and
 * that is the whole point. `/login` is a relative path, so a Next `<Link>` to it
 * resolved against gotcha.co.il and the router serviced it CLIENT-SIDE - no
 * request left the browser, so nginx's `return 301 https://app.gotcha.co.il`
 * never ran and the visitor stayed on the marketing origin. There the login shim
 * cannot work at all: OIDC discovery is a cross-origin fetch, and Authentik
 * grants CORS only to origins it has registered as redirect URIs, so the
 * request is blocked and sign-in dead-ends on "We could not reach secure
 * sign-in".
 *
 * Everywhere else (the application host, dev, any single-host deployment) the
 * relative path is correct and is returned unchanged.
 */
export function loginUrl(currentOrigin: string, next?: string): string {
  const path = isSafeReturnPath(next) ? `/login?next=${encodeURIComponent(next)}` : "/login";
  if (!isMarketingHost(currentOrigin) || !appOrigin) return path;
  return `${appOrigin}${path}`;
}

/**
 * Is this a path we are willing to send someone to after they authenticate?
 *
 * A leading "/" alone is not enough. `//evil.test` starts with one and is a
 * PROTOCOL-RELATIVE url - browsers resolve it to https://evil.test, so it turns
 * our own login into an open redirect. `/\evil.test` is the same trick with the
 * separator browsers also accept. Only a single slash followed by something
 * that is not a slash or backslash is a path on this origin.
 */
export function isSafeReturnPath(next: string | null | undefined): next is string {
  if (!next || !next.startsWith("/")) return false;
  return next[1] !== "/" && next[1] !== "\\";
}
