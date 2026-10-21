import { withSentryConfig } from '@sentry/nextjs/config';
import createNextIntlPlugin from 'next-intl/plugin';
import type { NextConfig } from 'next';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

/**
 * Where this app is mounted, from `NEXT_PUBLIC_BASE_PATH`.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ENV-DRIVEN, BECAUSE A HARDCODED PREFIX WOULD MOVE LOCAL DEVELOPMENT TOO
 * ════════════════════════════════════════════════════════════════════════════
 * The app is to be served under `/v2` alongside the existing product, sharing
 * nothing. A literal `basePath: '/v2'` would also move every route in `next
 * dev` — and all 22 capture specs navigate to `/${locale}/…`, so the whole
 * evidence chain would go red for a deployment concern.
 *
 * Unset locally, `/v2` in the container. `basePath` is applied at BUILD time
 * and inlined into the client bundle, so this must be set for `next build`,
 * not merely at runtime.
 *
 * ── AND IT CARRIES THE `NEXT_PUBLIC_` PREFIX ON PURPOSE ──
 * The browser needs this string too: `fetch` does not prefix itself, and no
 * public API exposes `basePath` to client code. Two attempts to publish it
 * from a private `APP_BASE_PATH` both failed silently, with the bundle still
 * containing a bare `"/api/bff"` — the `env:` config key did not reach the
 * replacement, and neither did assigning `process.env` inside this file.
 *
 * `NEXT_PUBLIC_*` is the documented mechanism and it works, so one variable
 * with the prefix beats two that must agree. The alternative — a private name
 * plus a public mirror — fails in the worst way available: links prefixed,
 * fetches not, on a deployment beside another application that answers the
 * unprefixed paths.
 *
 * Normalised here so the rest of the app can assume the shape: a leading
 * slash, no trailing one, and `''` rather than `undefined` at the root.
 */
const rawBasePath = process.env.NEXT_PUBLIC_BASE_PATH?.trim() ?? '';
const basePath = rawBasePath === '' || rawBasePath === '/' ? '' : rawBasePath.replace(/\/+$/, '');

if (basePath !== '' && !basePath.startsWith('/')) {
  throw new Error(
    `NEXT_PUBLIC_BASE_PATH must start with "/" — got ${JSON.stringify(rawBasePath)}. ` +
      'A prefix without one is silently ignored by Next and the app would serve at the root ' +
      'while everything around it expected otherwise.',
  );
}

/**
 * Response headers applied to every route.
 *
 * The Content-Security-Policy itself is issued per request by `src/proxy.ts`,
 * because it carries a fresh nonce. These are the static complements.
 *
 * `X-Frame-Options` duplicates the CSP's `frame-ancestors 'none'` for older
 * browsers that ignore CSP - clickjacking is the one risk worth stating twice,
 * since a framed, signed-in operator can be made to click anything.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  ...(basePath === '' ? {} : { basePath }),

  poweredByHeader: false,
  typedRoutes: true,
  experimental: {
    // Ships only the icons/utilities actually imported from these packages
    // rather than the whole barrel file.
    optimizePackageImports: ['radix-ui', '@tanstack/react-query'],
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default withSentryConfig(withNextIntl(nextConfig), {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: process.env.NODE_ENV !== 'production',
  // Source maps are uploaded and then deleted from the build output, so
  // production JavaScript stays unreadable to anyone who fetches it.
  sourcemaps: { deleteSourcemapsAfterUpload: true },
  /*
   * Routes Sentry's own requests through this app's origin, so an ad blocker
   * cannot silently discard error reports.
   *
   * ★★ NOT PREFIXED HERE, BECAUSE NEXT ALREADY DOES IT. A first version wrote
   * `${basePath}/monitoring` and the built rewrite came out
   * **`/v2/v2/monitoring`** — `tunnelRoute` becomes a rewrite, and rewrite
   * sources are prefixed with `basePath` automatically. Checked in the routes
   * manifest rather than reasoned about, which is how the doubling was found.
   */
  tunnelRoute: '/monitoring',
});
