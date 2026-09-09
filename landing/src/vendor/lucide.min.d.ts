/**
 * The vendored lucide UMD build ships no types. It exposes each icon as an
 * IconNode tuple: ['svg', rootAttrs, [[tag, attrs], ...]] - which is the shape
 * the design's glyph() and paintIcons() destructure.
 */
declare const lucide: {
  icons?: Record<string, any>;
  [name: string]: any;
};

export default lucide;
