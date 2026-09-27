/**
 * Faithful re-implementation of the three dc-runtime behaviours the generated
 * template depends on. Each mirrors the corresponding function in the design
 * project's `support.js`, so the rendered DOM matches the design canvas exactly
 * rather than approximately.
 *
 * `L` (the sc-for list coercion) is absent on purpose: this design has no
 * loops, and the compiler refuses to emit one, so a helper for it here would be
 * dead code pretending the feature is supported.
 */
import React from 'react';

/** support.js: kebabToCamel */
const kebabToCamel = (s: string) => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

const styleCache = new Map<string, React.CSSProperties>();

/**
 * support.js: cssToObj. The naive `split(';')` is deliberate - it is what the
 * runtime does, and the design's inline styles are written to suit it. Cached
 * because the generated template calls this on every render, and this page
 * re-renders on every keystroke in the form.
 */
export function st(css: string): React.CSSProperties {
  const hit = styleCache.get(css);
  if (hit) return hit;
  const o: Record<string, string> = {};
  for (const decl of css.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim();
    o[prop.startsWith('--') ? prop : kebabToCamel(prop)] = decl.slice(i + 1).trim();
  }
  styleCache.set(css, o);
  return o;
}

/**
 * support.js: walkText's interpolation branch. A scalar interpolation renders
 * inside `<span class="sc-interp">`, not as a bare text node. The span is
 * unstyled but it is still a real inline box, so dropping it would change
 * layout inside the design's many flex rows.
 */
export function I(v: unknown): React.ReactNode {
  if (React.isValidElement(v) || Array.isArray(v)) return <>{v as React.ReactNode}</>;
  if (v === null || v === undefined || typeof v === 'boolean') return null;
  return <span className="sc-interp">{String(v)}</span>;
}

/** support.js: compileAttr's mixed-value branch joins with `?? ''`. */
export const A = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
