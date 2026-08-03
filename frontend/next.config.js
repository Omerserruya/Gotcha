/** @type {import('next').NextConfig} */
// NEXT_OUTPUT controls the build target.
//   - "export"     → static HTML in /out, served by nginx in prod (Dockerfile.prod)
//   - "standalone" → Node server in /.next/standalone, used for dev (Dockerfile)
// Default is "standalone" so local docker compose builds the dev image.
const output = process.env.NEXT_OUTPUT === "export" ? "export" : "standalone";

const nextConfig = {
  reactStrictMode: true,
  output,
  ...(output === "export"
    ? { trailingSlash: true, images: { unoptimized: true } }
    : {}),
};

// ─── Sentry ────────────────────────────────────────────────────────────────
//
// Source maps are uploaded ONLY for an explicit production release. All three
// must be present, and CI must not set them for any other job:
//
//   SENTRY_AUTH_TOKEN   the credential (never committed, never in the bundle)
//   SENTRY_ORG          the org to upload to
//   SENTRY_RELEASE      an explicit release - never derived, never defaulted
//
// Without them the wrapper is skipped entirely, so `next build` on a laptop or
// in a type-check job does no network I/O and needs no Sentry credentials.
// The SDK itself is gated separately in sentry.client.config.ts; this block
// only governs UPLOAD.
const sentryReleaseRequested =
  Boolean(process.env.SENTRY_AUTH_TOKEN) &&
  Boolean(process.env.SENTRY_ORG) &&
  Boolean(process.env.SENTRY_RELEASE) &&
  process.env.SENTRY_ENVIRONMENT === "production";

if (!sentryReleaseRequested) {
  module.exports = nextConfig;
} else {
  const { withSentryConfig } = require("@sentry/nextjs");
  module.exports = withSentryConfig(nextConfig, {
    org: process.env.SENTRY_ORG,
    project: "gotcha-frontend",
    authToken: process.env.SENTRY_AUTH_TOKEN,
    release: { name: process.env.SENTRY_RELEASE },
    // Upload them, then delete them: readable stack traces in Sentry without
    // shipping the sources to every visitor.
    sourcemaps: { deleteSourcemapsAfterUpload: true },
    silent: true,
    // The tunnel route rewrites events through our own origin to dodge ad
    // blockers. It needs a SERVER to proxy through, and production is a static
    // export - there is none, so enabling it would silently drop every event.
    tunnelRoute: undefined,
  });
}
