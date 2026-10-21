import '../fonts/fonts.css';
import './font-families.css';

/**
 * The typefaces named by the GOTCHA Directions design.
 *
 * ★ SERVED FROM THIS REPO (2026-10-21), NOT BY `next/font/google`. That loader
 * downloads the fonts during `next build`, and the production image is built
 * for arm64 under QEMU, whose networking cannot reach fonts.gstatic.com - the
 * build hung. `scripts/fetch-fonts.mjs` fetched the same files once (Google's
 * own rules, the same subsets and `unicode-range`), into `../fonts/`. No
 * request leaves for Google, so the CSP keeps `font-src 'self'`.
 *
 * What next/font did and this does not: a size-adjusted fallback face, so the
 * swap from the system font shifts text a little more. `font-display: swap`
 * stays.
 *
 * Each family is named by a CSS variable (font-families.css), so `tokens.css`
 * refers to a name and nothing else in the codebase knows which font it is.
 *
 * The families, and why:
 *
 * - Archivo (`--font-archivo`, variable 100-900, latin): the workhorse.
 *   Everything that is not a display line or a label.
 *
 * - Heebo (`--font-heebo`, variable 100-900, hebrew + latin): the Hebrew
 *   companion to Archivo. A decision the design does not cover: `GOTCHA
 *   Directions` specifies Archivo, and Archivo has no Hebrew glyphs, so a
 *   Hebrew page would fall through to whatever the browser picks - the
 *   "English UI with Hebrew poured in" outcome the brief rules out. Heebo is a
 *   neutral grotesque with the same weight range and similar vertical
 *   proportions, so a Hebrew screen keeps the colour and rhythm of its English
 *   counterpart. A substitution, flagged for approval: changing it is the
 *   fetch script plus the `:lang(he)` token.
 *
 * - Instrument Serif (`--font-instrument-serif`, 400 normal + italic, latin):
 *   display serif, used italic and sparingly - the date above a greeting, the
 *   one line of scale on the sign-in panel. It carries the product's voice, so
 *   it must never end up on body text.
 *
 * - Frank Ruhl Libre (`--font-frank-ruhl-libre`, variable 300-900, hebrew +
 *   latin): the Hebrew display serif. A second gap the design does not cover:
 *   Instrument Serif has no Hebrew glyphs, and Hebrew has no italic tradition
 *   (a browser shears the letters, which reads as a rendering fault). Frank
 *   Ruhl Libre is set upright; the emphasis in Hebrew comes from the serif
 *   contrast against Heebo. Flagged for approval alongside Heebo.
 *
 * - IBM Plex Mono (`--font-ibm-plex-mono`, 400 + 500, latin): the tracked
 *   uppercase eyebrows, counters and keyboard hints. Its tabular figures are
 *   why counts in a column line up.
 */

/** The class on <html> that names every family (font-families.css). */
export const fontVariables = 'gotchaFonts';
