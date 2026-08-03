/** @type {import('next').NextConfig} */
// NEXT_OUTPUT controls the build target.
//   - "export"     → static HTML in /out, served by nginx in prod (Dockerfile.prod)
//   - "standalone" → Node server in /.next/standalone, used for dev (Dockerfile)
// Default is "standalone" so local docker compose builds the dev image.
const output = process.env.NEXT_OUTPUT === "export" ? "export" : "standalone";

const nextConfig = {
  reactStrictMode: true,
  output,
  // Next 14 + @sentry/nextjs: silences the SDK's version-detection warning.
  // Server instrumentation is irrelevant here (production is a static export),
  // but leaving the warning in the build output trains people to ignore it.
  experimental: { instrumentationHook: true },
  ...(output === "export"
    ? { trailingSlash: true, images: { unoptimized: true } }
    : {}),
};

// ─── Sentry ────────────────────────────────────────────────────────────────
//
// TWO independent decisions, and conflating them is a mistake worth spelling
// out: an earlier version gated the whole wrapper on the source-map upload
// credentials, which meant a build with a DSN but no auth token shipped with
// NO browser SDK at all. The DSN was set, the bundle was silent, and nothing
// in the build output said so.
//
//   1. WRAP - required for the SDK to exist in the browser at all. The wrapper
//      is what injects sentry.client.config.ts into the bundle. Needed whenever
//      a DSN is baked in, credentials or not.
//   2. UPLOAD source maps - needs SENTRY_AUTH_TOKEN + SENTRY_ORG +
//      SENTRY_RELEASE and an explicit production release. Without them stack
//      traces arrive minified, which is a degraded experience, not a dead one.
const sentryDsnPresent = Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN || process.env.SENTRY_FRONTEND_DSN);
const sentryUploadRequested =
  Boolean(process.env.SENTRY_AUTH_TOKEN) &&
  Boolean(process.env.SENTRY_ORG) &&
  Boolean(process.env.SENTRY_RELEASE) &&
  process.env.SENTRY_ENVIRONMENT === "production";

if (!sentryDsnPresent) {
  // No DSN: no wrapper, no network I/O, no credentials needed. This is the
  // state a laptop build and a CI type-check run in.
  module.exports = nextConfig;
} else {
  const { withSentryConfig } = require("@sentry/nextjs");
  module.exports = withSentryConfig(nextConfig, {
    org: process.env.SENTRY_ORG,
    project: "gotcha-frontend",
    authToken: sentryUploadRequested ? process.env.SENTRY_AUTH_TOKEN : undefined,
    release: process.env.SENTRY_RELEASE ? { name: process.env.SENTRY_RELEASE } : undefined,
    // Upload only on an explicit production release; otherwise generate
    // nothing and contact nothing.
    sourcemaps: sentryUploadRequested
      ? { deleteSourcemapsAfterUpload: true }
      : { disable: true },
    silent: true,
    // Needs a SERVER to proxy through and production is a static export, so
    // enabling it would silently drop every event.
    tunnelRoute: undefined,
  });
}
