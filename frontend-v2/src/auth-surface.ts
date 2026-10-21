/**
 * The screens that make up the sign-in surface.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ ITS OWN MODULE, BECAUSE THE LIST IS A FACT ABOUT THE APP
 * ════════════════════════════════════════════════════════════════════════════
 * It lived inside the proxy as `(?:sign-in)` - an alternation with one branch.
 * Adding the recovery screen to the `(auth)` route group therefore shipped a
 * route the surface's own build answered 404 for: the href, the source and the
 * compiled output were all correct, and the origin refused the screen.
 *
 * ★ The same constant had already failed the same way once - it permitted
 *   `/sign-in`, the app redirected to `/en/sign-in`, and the screen 404'd
 *   behind a redirect that looked fine. That fix taught it about locales. It
 *   did not make it a list.
 *
 * ★ Here rather than in `proxy.ts` so a test can read it without importing the
 *   proxy, which pulls in Next's middleware runtime. A guard nobody can test
 *   cheaply is a guard that gets tested late.
 *
 * ⚠ `auth-surface.test.ts` enumerates the `(auth)` route directory and fails
 *   if a screen exists that this does not name. Nobody has to remember an
 *   allowlist in another file from the route they just added - twice now,
 *   nobody did.
 */
export const AUTH_SURFACE_ROUTES = ['sign-in', 'recover'] as const;

/**
 * Matches `/sign-in`, `/en/sign-in`, `/he/recover/anything` - the surface's
 * screens with or without a locale prefix.
 */
export const PUBLIC_PATH_PATTERN = new RegExp(
  `^/(?:[a-z]{2}/)?(?:${AUTH_SURFACE_ROUTES.join('|')})(?:/|$)`,
);

/**
 * Pages a person reaches from a link in an email, before they can sign in.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE GATE LETS THESE THROUGH. NOTHING ELSE ABOUT THE SIGN-IN SURFACE DOES.
 * ════════════════════════════════════════════════════════════════════════════
 * `PUBLIC_PATH_PATTERN` means more than "no session needed": the proxy also
 * narrows the CSP on it, serves ONLY it on the auth origin, and relocates it
 * to `SIGN_IN_URL`. An invitation or a checkout is none of those things - it
 * belongs to the product origin, and a narrowed `frame-src` on a payment page
 * would break it. So this is a second list beside the first, read by the
 * gate's one exemption and by nothing else.
 *
 *   join                 an invitation (services/auth onboarding.ts, the
 *                        `/join?token=` link)
 *   setup-link/expired   where a setup link that cannot be redeemed lands
 *                        (services/auth setup-link.ts `expiredPage`)
 *   checkout/…           the payment pages; the backend sends a person there
 *                        from an email or a payment provider
 *
 * ★ `/account/verify-email` is NOT here, on purpose: its backend route
 *   (`POST /api/account/email-change/verify`) requires the session, and the
 *   legacy page sent a signed-out visitor to sign in first. The gate already
 *   does exactly that, with the link's token in `returnTo`.
 *
 * ⚠ Whole paths, not prefixes: `/checkout/anything` is not a page anybody
 *   built, and `/account` is the product.
 */
export const SIGNED_OUT_ROUTES = [
  'join',
  'setup-link/expired',
  'checkout',
  'checkout/payment-required',
  'checkout/processing',
  'checkout/completed',
  'checkout/failed',
  'checkout/cancelled',
  'checkout/expired',
] as const;

/** `/join`, `/he/join`, `/en/checkout/failed/` - exactly these, locale or not. */
export const SIGNED_OUT_PATH_PATTERN = new RegExp(
  `^/(?:[a-z]{2}/)?(?:${SIGNED_OUT_ROUTES.join('|')})/?$`,
);
