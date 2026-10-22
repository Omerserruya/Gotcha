/**
 * Where this app is mounted, when it is not at the root.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ONE ENVIRONMENT VARIABLE, READ IN TWO PLACES, NEVER TWO VARIABLES
 * ════════════════════════════════════════════════════════════════════════════
 * `APP_BASE_PATH` is read by `next.config.ts` to set `basePath`, and inlined
 * from there into `NEXT_PUBLIC_BASE_PATH` so the browser can see the same
 * value. Declaring a second variable for the client would be two things to
 * keep in step, and the failure would be silent: links prefixed and fetches
 * not.
 *
 * ── WHAT NEXT DOES FOR YOU, AND WHAT IT DOES NOT ──
 * `next/link`, the router, `redirect()` and the `source` of `headers()` and
 * `redirects()` are all prefixed automatically. **`fetch` is not, and neither
 * is `new URL()`** - those are plain web APIs with no knowledge of the app's
 * mount point, and they are where this leaks.
 *
 * `basePath` is applied at BUILD time and inlined into the client bundle, so
 * this value is fixed when `next build` runs. Setting `APP_BASE_PATH` only at
 * runtime does nothing.
 */

/**
 * `''` at the root, or a path with a leading and no trailing slash.
 *
 * Read from the inlined public variable so the same string is available on the
 * server and in the browser. `next.config.ts` normalises it.
 */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/**
 * An in-app absolute path, prefixed for wherever this app is mounted.
 *
 * For `fetch` and anything else that takes a URL string directly. **Not for
 * `next/link` or `redirect()`** - they prefix it themselves, and passing an
 * already-prefixed path to them produces `/v2/v2/…`.
 */
export function appPath(path: `/${string}`): string {
  return `${BASE_PATH}${path}`;
}

/**
 * An absolute URL for an in-app path, against an origin that may itself carry
 * the mount point.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ `new URL('/a', 'https://host/v2')` IS `https://host/a`
 * ════════════════════════════════════════════════════════════════════════════
 * An absolute path DISCARDS the base's path - with or without a trailing
 * slash. So composing the OIDC `redirect_uri` as
 * `new URL('/api/auth/callback', APP_ORIGIN)` silently drops the mount point
 * and produces a URL that belongs to whatever else is served at that origin.
 *
 * Under `/v2` beside the legacy product that is not a 404: it is the OTHER
 * application's route, and the identity provider would be handed a redirect
 * target we do not own.
 *
 * So the origin is reduced to its origin and the path is rebuilt from
 * `BASE_PATH`, which makes the result independent of whether whoever set
 * `APP_ORIGIN` happened to include the prefix.
 */
export function appUrl(path: `/${string}`, origin: string): string {
  const url = new URL(origin);
  return `${url.origin}${appPath(path)}`;
}
