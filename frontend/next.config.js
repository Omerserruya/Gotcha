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

module.exports = nextConfig;
