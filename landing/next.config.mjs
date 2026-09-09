/**
 * The marketing site ships as a static export, the way frontend/ does: nginx in
 * the gateway image serves the files and there is no Node runtime in
 * production. Every page here is statically generated already, so nothing is
 * given up by it.
 *
 * NEXT_OUTPUT mirrors frontend/next.config.mjs so both builds are driven the
 * same way; `next dev` ignores it.
 */
const output = process.env.NEXT_OUTPUT === 'export' ? 'export' : undefined;

/** @type {import('next').NextConfig} */
const nextConfig = {
  output,
  reactStrictMode: true,
  // A static host has no rewrite layer, so /legal must be a real directory
  // with an index.html inside it rather than a /legal.html file.
  trailingSlash: false,
  // The design ships its own <img> tags with hand-tuned inline sizing; the
  // image optimiser would rewrite those and change the crop.
  images: { unoptimized: true },
};

export default nextConfig;
