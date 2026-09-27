/**
 * Where a campaign page sends people.
 *
 * ABSOLUTE BY DEFAULT, and that is the one real difference from
 * landing/src/lib/site.ts.
 *
 * There, an unset variable falls back to a same-origin path, because every
 * section of the marketing site is served out of one build and a relative link
 * is correct on localhost and correct behind the vhosts. Here it would be a
 * bug that only appears in production: go.gotcha.co.il has no /login and no
 * /pricing, so a relative link would be answered by this host's own catch-all
 * and the merchant would land back on the campaign page they just tried to
 * leave. Every link out of a campaign page crosses a hostname.
 *
 * So the fallbacks below are the real production URLs rather than paths. An
 * env override still wins, which is what a staging build or a localhost run
 * uses. These are inlined at BUILD time (static export) - changing one means
 * rebuilding the campaigns bundle, not restarting anything.
 */

const abs = (raw: string | undefined, fallback: string, path = '') => {
  const base = (raw ?? '').trim() || fallback;
  try {
    return new URL(path, base).toString();
  } catch {
    return new URL(path, fallback).toString();
  }
};

export const links = {
  /** The marketing site. Where "learn more" goes. */
  home: (path = '/') => abs(process.env.NEXT_PUBLIC_MARKETING_URL, 'https://gotcha.co.il', path),
  /** The product. Where the campaign's primary call to action goes. */
  app: (path = '/login') => abs(process.env.NEXT_PUBLIC_APP_URL, 'https://app.gotcha.co.il', path),
  /** Legal documents, for the footer line a paid page is obliged to carry. */
  trust: (slug?: string) =>
    abs(
      process.env.NEXT_PUBLIC_TRUST_URL,
      'https://trust.gotcha.co.il',
      slug ? `/legal/${slug}` : '/legal',
    ),
};

/**
 * The palette, restated for pages written by hand.
 *
 * A deliberately short list. The marketing site's `C` has thirty entries
 * because the design file has thirty; a campaign page that needs a thirty-first
 * colour should just write it inline.
 */
export const C = {
  bg: '#FAF8F4',
  ink: '#16150F',
  body: '#5B564D',
  muted: '#8E887C',
  faint: '#A29B8E',
  card: '#FFFFFF',
  surface: '#F7F5F1',
  sand: '#EFEAE1',
  line: '#E8E3D9',
  accent: '#C4552F',
  accentDeep: '#8E3418',
  accentWash: '#FBEEE8',
  footerBg: '#16150F',
  footerInk: '#F7F5F1',
} as const;

export const F = {
  sans: 'Archivo, Heebo, sans-serif',
  serif: "'Instrument Serif', Georgia, serif",
  mono: "'IBM Plex Mono', ui-monospace, monospace",
} as const;

/**
 * GOTCHA's pixel, the same one the marketing site loads.
 *
 * Hard-coded rather than left to the environment because a campaign that ships
 * without it silently cannot report its own conversions, and "someone remembers
 * to set a build variable" is not a mechanism. It is not a secret either: a
 * pixel id is in the page's source on every site that uses one, and this exact
 * value is already in landing/src/components/MetaPixel.tsx.
 *
 * A campaign measured by a different ad account overrides it with
 * NEXT_PUBLIC_META_PIXEL_ID at build time.
 */
const DEFAULT_PIXEL_ID = '1366778975443279';

/**
 * The Meta pixel, when there is one.
 *
 * Never null in practice now, but the type keeps the null case honest: an
 * override of `NEXT_PUBLIC_META_PIXEL_ID=` to an empty string turns measurement
 * off entirely, and `MetaPixel` then renders nothing and requests nothing.
 *
 * Note this alone does NOT start tracking anyone: the pixel is still gated on
 * `consent.marketing`, and nothing is requested from Meta until a visitor says
 * yes.
 *
 * It lives here, beside the other build-time constants, rather than being read
 * inside the generated campaign component - so that every value the page is
 * configured with is in one file that a person edits, instead of half of them
 * being in a file the design compiler overwrites.
 *
 * On the substitution itself: Next inlines a NEXT_PUBLIC_* variable that IS set
 * at build time, and leaves one that is not as a runtime lookup against its
 * `process` shim, which yields undefined and falls through to the default here.
 * Both behaviours are fine and both were checked against a real build.
 */
export const META_PIXEL_ID: string | null =
  process.env.NEXT_PUBLIC_META_PIXEL_ID || DEFAULT_PIXEL_ID;

export type Locale = 'en' | 'he';

export const dirOf = (l: Locale) => (l === 'he' ? 'rtl' : 'ltr');
