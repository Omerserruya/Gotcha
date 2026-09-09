/**
 * Derives a mobile override from one of the design's inline styles.
 *
 * The design is drawn for a 1440px canvas and has no breakpoint below 1100px,
 * so on a phone it overflows by roughly 340px and the header runs off the edge.
 * Desktop has to stay a byte-faithful clone, which rules out editing those
 * inline styles - so instead every element that needs one gets a class whose
 * rules live entirely inside a max-width media query. Above the breakpoint the
 * class matches nothing and the page renders exactly as it does today.
 *
 * The rules are derived, not hand-written per element: there are 1,622 inline
 * styles across the design, and a list of hand-picked selectors would rot on
 * the first re-export. Everything here keys on what a declaration *is* - a
 * headline size, a fixed track count, a width wider than a phone.
 */

/** True when a property's value is computed at render time. */
function isDynamic(css, prop) {
  return new RegExp(`(?:^|;)\\s*${prop}\\s*:[^;]*\\{\\{`).test(css);
}

/** Read a px value for a property out of a declaration string. */
function px(css, prop) {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)px`).exec(css);
  return m ? parseFloat(m[1]) : null;
}

function has(css, prop, value) {
  return new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*${value}`).test(css);
}

/**
 * Headline sizes, brought down without flattening the hierarchy.
 *
 * A straight percentage makes 76px readable and 34px tiny, so the scale is
 * anchored: everything keeps its distance from the others, just compressed.
 * 76 -> 38, 58 -> 32, 42 -> 27, 34 -> 24.
 *
 * The hero settled the slope. Its copy joins "interaction," to what follows
 * with a non-breaking space, so the phrase is one unbreakable run: at 42px it
 * measured 385px inside a 350px column and was clipped. 38px fits it.
 */
function mobileFontSize(size) {
  if (size <= 30) return null;
  return Math.round(20 + (size - 20) * 0.32);
}

/**
 * A grid that names its track count cannot fit a phone. `auto-fit` already
 * collapses on its own as long as its minimum is narrower than the screen, so
 * those are left alone rather than overridden into the same thing.
 */
function mobileGrid(value) {
  const v = value.trim();

  // `auto-fit` already collapses on its own, as long as its minimum is
  // narrower than the screen. Overriding those into the same thing is noise.
  const autofit = /auto-fit\s*,\s*minmax\(\s*(\d+)px/.exec(v);
  if (autofit) return parseFloat(autofit[1]) > 330 ? '1fr' : null;

  // repeat(N, ...) with N above one. Note there is no whitespace inside
  // `repeat(4,1fr)` - an earlier version keyed on a space and matched none of
  // the four-column rows that were pushing /pricing off the screen.
  const repeat = /repeat\(\s*(\d+)\s*,/.exec(v);
  if (repeat) return parseFloat(repeat[1]) > 1 ? '1fr' : null;

  // An explicit track list: "72px 1fr 1fr", "minmax(0,1fr) 120px minmax(0,1fr)".
  const tracks = v.split(/\s+(?![^(]*\))/).filter(Boolean);
  return tracks.length > 1 ? '1fr' : null;
}

/** Horizontal padding, reduced to a phone gutter while keeping the vertical. */
function mobilePadding(value) {
  const parts = value.trim().split(/\s+/);
  if (!parts.every((p) => /^\d+(\.\d+)?px$|^0$/.test(p))) return null;
  const n = (p) => (p === '0' ? 0 : parseFloat(p));
  const gutter = (v) => (v > 24 ? 20 : v);

  if (parts.length === 1) return n(parts[0]) > 24 ? `${gutter(n(parts[0]))}px` : null;
  if (parts.length === 2) {
    const [v, h] = parts.map(n);
    return h > 24 ? `${v}px ${gutter(h)}px` : null;
  }
  if (parts.length === 3) {
    const [t, h, b] = parts.map(n);
    return h > 24 ? `${t}px ${gutter(h)}px ${b}px` : null;
  }
  if (parts.length === 4) {
    const [t, r, b, l] = parts.map(n);
    return r > 24 || l > 24 ? `${t}px ${gutter(r)}px ${b}px ${gutter(l)}px` : null;
  }
  return null;
}

/**
 * The whole override for one inline style, or "" when the element is already
 * fine on a phone.
 */
export function mobileOverride(css) {
  const out = [];

  const fs = px(css, 'font-size');
  if (fs !== null) {
    const m = mobileFontSize(fs);
    // break-word is the safety net, not the plan: the size above is chosen so
    // headings wrap on their own. It only engages when a single run genuinely
    // cannot fit, which beats clipping the end of a sentence off the screen.
    if (m) out.push(`font-size:${m}px`, 'overflow-wrap:break-word');
  }

  // `font: 500 76px/1.05 Archivo` carries the size inside the shorthand.
  const shorthand = /(?:^|;)\s*font\s*:\s*([^;]+)/.exec(css);
  if (shorthand) {
    const size = /(\d+(?:\.\d+)?)px/.exec(shorthand[1]);
    if (size) {
      const m = mobileFontSize(parseFloat(size[1]));
      if (m) out.push(`font-size:${m}px`);
    }
  }

  const grid = /(?:^|;)\s*grid-template-columns\s*:\s*([^;]+)/.exec(css);
  if (isDynamic(css, 'grid-template-columns')) {
    // The track list is chosen at render time; on a phone it is one column.
    out.push('grid-template-columns:1fr');
  } else if (grid) {
    const m = mobileGrid(grid[1]);
    if (m) out.push(`grid-template-columns:${m}`);
  }

  /**
   * Every row is allowed to wrap. An earlier version only did this for rows
   * with a generous gap, on the theory that tight rows were small clusters -
   * but the card rows on /pricing and /why-gotcha use a 12px gap and were
   * exactly the ones pushing content off the screen. A small cluster that fits
   * does not wrap anyway, so allowing it costs nothing.
   */
  if (has(css, 'display', 'flex') && !has(css, 'flex-direction', 'column')) {
    out.push('flex-wrap:wrap');
  }

  const w = px(css, 'width');
  if (w !== null && w >= 340) out.push('width:100%', 'max-width:100%');

  const mw = px(css, 'max-width');
  if (mw !== null && mw >= 420) out.push('max-width:100%');

  // A width the design computes could be anything, and on the product pages it
  // is literally `none`. Clamp it rather than trust it.
  if (isDynamic(css, 'max-width') || isDynamic(css, 'width')) out.push('max-width:100%');

  const minw = px(css, 'min-width');
  if (minw !== null && minw >= 280) out.push('min-width:0');

  /**
   * nowrap is the single biggest cause of a page being wider than the phone:
   * a headline, a kicker or a bar of copy that is simply not allowed to break.
   * Small chips keep it - the design marks those `flex:none`, and a chip that
   * wraps mid-word looks broken - everything else is allowed to wrap.
   */
  if (
    has(css, 'white-space', 'nowrap') &&
    !has(css, 'flex', 'none') &&
    // Copy the design already truncates is meant to stay on one line.
    !has(css, 'text-overflow', 'ellipsis')
  ) {
    out.push('white-space:normal');
  }

  const pad = /(?:^|;)\s*padding\s*:\s*([^;]+)/.exec(css);
  if (pad && !pad[1].includes('{{')) {
    const m = mobilePadding(pad[1]);
    if (m) out.push(`padding:${m}`);
  }

  return out.join(';');
}
