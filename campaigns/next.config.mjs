/**
 * Campaign landing pages, served at go.gotcha.co.il.
 *
 * A THIRD Next app beside frontend/ and landing/, deliberately separate rather
 * than a section inside the marketing site. Campaign pages are written fast,
 * replaced often, and are frequently thrown away after a flight; keeping them
 * here means an ad page can ship without rebuilding or risking the marketing
 * site, and a bad campaign page cannot take gotcha.co.il down with it.
 *
 * Static export, like both of its siblings: nginx in the gateway image serves
 * the files and there is no Node runtime in production.
 */
const output = process.env.NEXT_OUTPUT === 'export' ? 'export' : undefined;

/** @type {import('next').NextConfig} */
const nextConfig = {
  output,
  reactStrictMode: true,
  /**
   * TRAILING SLASH ON, and this is the one setting here worth arguing about.
   *
   * It is `false` on landing/, and that is right there because nginx maps its
   * routes explicitly. These pages are different: each campaign is its own
   * directory, the URLs are pasted into ad platforms by hand, and an ad network
   * that appends or strips a slash must not produce a 404. `true` emits
   * `/<campaign>/index.html`, which nginx serves for both `/x` and `/x/`.
   *
   * Note this is the opposite of the app, where trailingSlash once broke every
   * `pathname ===` comparison in production. Nothing here compares pathnames;
   * these are static documents.
   */
  trailingSlash: true,
  // No image optimiser in a static export, and campaign art is hand-sized.
  images: { unoptimized: true },
};

export default nextConfig;
