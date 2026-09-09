/**
 * The design's vocabulary, named.
 *
 * The landing page itself is compiled from the design and carries these values
 * inline; the pages written by hand around it - the Trust Center, the help
 * articles, the cookie notice - read them from here so they speak the same
 * language rather than an approximation of it. Every value below appears in
 * "GOTCHA Landing.dc.html"; none was invented.
 */

export const C = {
  /** Page ground and the ink on it. */
  bg: '#FAF8F4',
  ink: '#16150F',

  /** Raised surfaces, lightest first. */
  card: '#FFFFFF',
  surface: '#F7F5F1',
  surfaceWarm: '#F5F2EC',
  sand: '#EFEAE1',
  line: '#E8E3D9',

  /** Text that is not the headline. */
  body: '#5B564D',
  muted: '#8E887C',
  faint: '#A29B8E',

  /** The accent, and the deeper tone the offer bar uses. */
  accent: '#C4552F',
  accentDeep: '#8E3418',
  accentWash: '#FBEEE8',

  /** The category tints the design assigns to groups of things. */
  greenWash: '#EDF4E7',
  green: '#2E7D5B',
  blueWash: '#EDF1F7',
  blue: '#3E5C99',
  violetWash: '#EAE4FB',
  violet: '#4B3E8E',
  sandWash: '#F0EDE7',
  clay: '#7A6A4F',
  goldWash: '#F7F0E2',
  gold: '#8A6A16',

  /** The footer is the one dark region. */
  footerBg: '#16150F',
  footerInk: '#F7F5F1',
  footerMuted: '#9A958D',
  footerLine: '#262521',

  live: '#A8C57A',
} as const;

export const F = {
  sans: 'Archivo, Heebo, sans-serif',
  serif: "'Instrument Serif', Georgia, serif",
  mono: "'IBM Plex Mono', ui-monospace, monospace",
} as const;

/** The pill the design uses for its fixed header. */
export const HEADER_PILL =
  'background:rgba(253,251,247,.7);backdrop-filter:blur(20px) saturate(1.7);' +
  '-webkit-backdrop-filter:blur(20px) saturate(1.7);border:1px solid rgba(22,21,15,.08);' +
  'border-radius:20px;box-shadow:0 8px 30px rgba(22,21,15,.1)';

export const MAXW = 1240;

export type Locale = 'en' | 'he';

/** Both languages are first class; the design opens in English. */
export const DEFAULT_LOCALE: Locale = 'en';

export const isHe = (l: Locale) => l === 'he';
export const dirOf = (l: Locale) => (isHe(l) ? 'rtl' : 'ltr');

/** Pick the right half of a [en, he] pair. */
export function t<T>(pair: readonly [T, T], locale: Locale): T {
  return isHe(locale) ? pair[1] : pair[0];
}

/**
 * Where the other sections live.
 *
 * In production each of these is its own hostname in front of this one app, the
 * way help.gotcha.co.il already works: nginx rewrites the subdomain root onto
 * the section's path. Unset - dev, or any single-host deployment - means "same
 * origin", so every link stays a plain path and the site works on localhost
 * exactly as it does behind the vhosts.
 */
const host = (raw: string | undefined, path: string) => {
  const v = (raw ?? '').trim();
  if (!v) return path;
  try {
    return new URL(path, v).toString();
  } catch {
    return path;
  }
};

export const links = {
  home: () => host(process.env.NEXT_PUBLIC_MARKETING_URL, '/'),
  trust: (slug?: string) =>
    host(process.env.NEXT_PUBLIC_TRUST_URL, slug ? `/legal/${slug}` : '/legal'),
  help: (path = '') => host(process.env.NEXT_PUBLIC_HELP_URL, `/help${path}`),
  app: () => host(process.env.NEXT_PUBLIC_APP_URL, '/login'),
};
