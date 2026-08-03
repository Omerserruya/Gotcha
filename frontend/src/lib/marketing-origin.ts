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
