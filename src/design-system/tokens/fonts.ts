import {
  Archivo,
  Frank_Ruhl_Libre,
  Heebo,
  IBM_Plex_Mono,
  Instrument_Serif,
} from 'next/font/google';

/**
 * The typefaces named by the GOTCHA Directions design.
 *
 * Loaded through `next/font`, which self-hosts them and emits a `@font-face`
 * with `font-display: swap` plus a size-adjusted fallback. That matters twice
 * over here: no request leaves for Google, and the Content-Security-Policy can
 * keep `font-src 'self'` without an exception.
 *
 * Each exposes a CSS variable, so `tokens.css` refers to a name rather than a
 * hashed class and nothing else in the codebase knows which font it is.
 */

/** The workhorse. Everything that is not a display line or a label. */
export const archivo = Archivo({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-archivo',
  display: 'swap',
});

/**
 * The Hebrew companion to Archivo.
 *
 * ── A decision the design does not cover ───────────────────────────────────
 * `GOTCHA Directions` specifies Archivo, and **Archivo has no Hebrew glyphs**.
 * Setting it on a Hebrew page would silently fall through to whatever the
 * browser picks - usually Arial or David - which is exactly the "English UI
 * with Hebrew poured in" outcome the brief rules out.
 *
 * Heebo is chosen because it is a neutral grotesque with the same weight range
 * (400-700) and similar vertical proportions, so a Hebrew screen keeps the
 * same colour and rhythm as its English counterpart rather than reading as a
 * different product.
 *
 * This is a substitution, not a design instruction, and it is flagged for
 * approval. Changing it is one line here plus the `:lang(he)` token.
 * ──────────────────────────────────────────────────────────────────────────
 */
export const heebo = Heebo({
  subsets: ['hebrew', 'latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-heebo',
  display: 'swap',
});

/**
 * Display serif, used italic and sparingly: the date above a greeting, the
 * one line of scale on the sign-in panel. It carries the product's voice, so
 * it must never end up on body text.
 */
export const instrumentSerif = Instrument_Serif({
  subsets: ['latin'],
  weight: ['400'],
  style: ['normal', 'italic'],
  variable: '--font-instrument-serif',
  display: 'swap',
});

/**
 * Monospace, for the tracked uppercase eyebrows, counters and keyboard hints.
 * Its tabular figures are why counts in a column line up.
 */
/**
 * The Hebrew display serif.
 *
 * ── A second gap the design does not cover ────────────────────────────────
 * Instrument Serif has no Hebrew glyphs either, and the design uses it
 * *italic*. Both are problems in Hebrew:
 *
 *   - the glyphs fall through to whatever serif the browser has;
 *   - Hebrew has no italic tradition, so the browser synthesises a slant by
 *     shearing the letterforms. It reads as a rendering fault, not as emphasis.
 *
 * Frank Ruhl Libre is a Hebrew serif with real Latin companion glyphs, and it
 * is set upright - the emphasis in Hebrew comes from the serif contrast
 * against Heebo, which is how the distinction is actually made in Hebrew
 * typography.
 *
 * Flagged for approval alongside the Heebo substitution.
 * ──────────────────────────────────────────────────────────────────────────
 */
export const frankRuhlLibre = Frank_Ruhl_Libre({
  subsets: ['hebrew', 'latin'],
  weight: ['400', '500'],
  variable: '--font-frank-ruhl-libre',
  display: 'swap',
});

export const ibmPlexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-ibm-plex-mono',
  display: 'swap',
});

export const fontVariables = [
  archivo.variable,
  heebo.variable,
  instrumentSerif.variable,
  frankRuhlLibre.variable,
  ibmPlexMono.variable,
].join(' ');
