/**
 * The design reached for `window.lucide`, a global set by a CDN <script>. That
 * only exists in the browser, and the design's `glyph()` runs inside
 * renderVals() - i.e. during render - so on the server it would fall back to
 * blank circles and then mismatch on hydration.
 *
 * Bundling the same UMD build instead gives one icon source that resolves
 * identically on the server and the client, with no third-party CDN.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
import lucideUmd from '@/vendor/lucide.min.js';

const lucide: any = (lucideUmd as any)?.icons ? lucideUmd : { icons: lucideUmd };

// paintIcons() is copied from the design and still reads the global.
if (typeof window !== 'undefined') (window as any).lucide = lucide;

export function getLucide(): any {
  return lucide;
}
