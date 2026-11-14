/**
 * gsap, ScrollTrigger and Lenis for the v8 home, at the versions the design
 * loads from jsdelivr (gsap 3.12.5, lenis 1.1.13).
 *
 * The design fetches them at runtime with `this.load(<cdn url>)` and then reads
 * window.gsap, window.ScrollTrigger and window.Lenis. Two things rule out
 * serving the same files as plain scripts: production's CSP allows scripts
 * from 'self' only, and the production landing vhost serves `.js` only under
 * /_next/ - anything else ending in .js is 301'd to the application host. So
 * they are bundled instead, as lazy chunks under /_next/static/, still fetched
 * only when the design asks for them, and set on window the way the CDN
 * scripts set themselves.
 */
const LOADERS = {
  gsap: () => import('@/vendor/v8/gsap.min.js').then((m) => {
    window.gsap = m.gsap || (m.default && m.default.gsap);
  }),
  ScrollTrigger: () => import('@/vendor/v8/ScrollTrigger.min.js').then((m) => {
    window.ScrollTrigger = m.ScrollTrigger || (m.default && m.default.ScrollTrigger);
  }),
  Lenis: () => import('@/vendor/v8/lenis.min.js').then((m) => {
    window.Lenis = m.default || m;
  }),
};

export function loadVendor(name) {
  return LOADERS[name]();
}
