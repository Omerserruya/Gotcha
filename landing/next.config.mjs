/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The design ships its own <img> tags with hand-tuned inline sizing; the
  // image optimiser would rewrite those and change the crop.
  images: { unoptimized: true },
};

export default nextConfig;
