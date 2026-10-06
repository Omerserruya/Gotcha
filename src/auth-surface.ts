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
