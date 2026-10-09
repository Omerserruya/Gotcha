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
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ A VARIABLE FONT TAKES NO `weight` ARRAY, AND HEEBO BLOCKED THE BUILD
 * ════════════════════════════════════════════════════════════════════════════
 * `next/font/google`'s reference is explicit: an array of weights *"applies if
 * the font is **not** a variable google font"*. For a variable font you omit
 * `weight` (or give a range) and the whole axis is served from one file per
 * subset.
 *
 * Heebo had `weight: ['400','500','600','700']` and is variable - `wght`
 * 100-900 - so Next generated a static face per weight per subset, **twenty of
 * them**, and every one failed Turbopack's import map with *"next/font/google
 * queries have exactly one entry"*. Twenty errors, twenty faces. Removing the
 * array builds clean and emits five faces, one per subset, with the two named
 * in `subsets` preloaded.
 *
 * Archivo is variable with the same array and did NOT fail, so the array alone
 * is not the trigger - something about Heebo's face set differs, and it has two
 * subsets the others do not (`math`, `symbols`). **The precise mechanism is not
 * established here.** What is established is that the configuration was wrong
 * against the documented API for every variable font in this file, and it built
 * only until a `.next` cache was cleared - so the next clean build anywhere,
 * including CI, would have hit it.
 *
 * Which is why the two other variable fonts are corrected too rather than left
 * for the same discovery. It also costs less: Archivo went from twelve faces to
 * three.
 *
 * ── AND TWO ARE LEFT WITH THEIR ARRAYS ON PURPOSE ──
 * `Instrument_Serif` and `IBM_Plex_Mono` are **not** variable - no `axes` in
 * Next's own font data - so an array is the correct and only way to ask for
 * their weights. The asymmetry in this file is the fonts differing, not an
 * oversight.
 */

/** The workhorse. Everything that is not a display line or a label. */
export const archivo = Archivo({
  subsets: ['latin'],
  /* Variable: `wght` 100-900 and `wdth` 62-125. No `axes`, so only `wght`
     travels - the width axis is never varied here. */
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
  /* NOT a variable font - no axes in Next's font data - so the array stays. */
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
  /* Variable: `wght` 300-900, which covers the 400 and 500 this asked for. */
  variable: '--font-frank-ruhl-libre',
  display: 'swap',
});

export const ibmPlexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  /* NOT a variable font either. The array is correct here. */
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
