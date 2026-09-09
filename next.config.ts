import { withSentryConfig } from '@sentry/nextjs/config';
import createNextIntlPlugin from 'next-intl/plugin';
import type { NextConfig } from 'next';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

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
  // Routes Sentry's own requests through this app's origin, so an ad blocker
  // cannot silently discard error reports.
  tunnelRoute: '/monitoring',
});
