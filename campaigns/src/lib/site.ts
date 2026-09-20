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
  card: '#FFFFFF',
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

export type Locale = 'en' | 'he';

export const dirOf = (l: Locale) => (l === 'he' ? 'rtl' : 'ltr');
