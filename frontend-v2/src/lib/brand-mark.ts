/**
 * A business's name as a brand, for the marks that stand in for a logo: the
 * web chat preview (13g) and 00d's site banner - one source for both
 * (supervisor, dev). A tenant name often carries a tagline ("Urban Supply -
 * GOTCHA demo"): the brand is the part before its first separator, and never
 * ends on one. A full stop is the name's own ("Aviv & Co.").
 */
const SEPARATOR = /\s[-|·:\u2013\u2014]\s|\s*[|·]\s*/u;
const TRAILING = /[\s\-|·:,;\u2013\u2014]+$/u;

export function brandName(name: string): string {
  const head = name.split(SEPARATOR)[0] ?? name;
  return head.trim().replace(TRAILING, '');
}

/** The logo "AVIV & CO." and the launcher's first word "AVIV", from one name. */
export function brandMark(name: string): { readonly logo: string; readonly launcher: string } {
  const upper = brandName(name).toUpperCase();
  const words = upper.split(/\s+/);
  let logo = '';
  for (const word of words) {
    if (logo && `${logo} ${word}`.length > 16) break;
    logo = logo ? `${logo} ${word}` : word;
  }
  const tidy = (text: string) => text.trim().replace(TRAILING, '');
  return { logo: tidy(logo), launcher: tidy(words[0] ?? '').slice(0, 5) };
}

/**
 * How a logo text sits in the preview's round mark (64px, 0.2em tracking):
 * sized by its LONGEST WORD, because a word is never broken - "URBAN SUPPL /
 * Y" across three lines was dev's (supervisor). A word too long for the
 * smallest size gives way to the initials.
 *
 *   l ≤ 5 letters   m ≤ 6   s ≤ 7   initials beyond
 */
export type LogoFit = 'l' | 'm' | 's' | 'initials';

export function logoFit(logo: string): LogoFit {
  const longest = Math.max(0, ...logo.split(/\s+/).map((word) => [...word].length));
  return longest <= 5 ? 'l' : longest <= 6 ? 'm' : longest <= 7 ? 's' : 'initials';
}

/** "URBAN SUPPLY" → "US"; one word → its first two letters; words without a letter are skipped. */
export function initials(name: string): string {
  const words = brandName(name)
    .toUpperCase()
    .split(/\s+/)
    .filter((word) => /\p{L}/u.test(word));
  if (words.length === 0) return '';
  if (words.length === 1) return [...words[0]!].slice(0, 2).join('');
  return words
    .slice(0, 2)
    .map((word) => [...word].find((ch) => /\p{L}/u.test(ch)) ?? '')
    .join('');
}

/**
 * The brand's one-letter mark - the widget's bubble and its pop-up's avatar
 * (design 7; supervisor, 2026-10-14). Its first letter or digit as a whole
 * grapheme (a Hebrew letter keeps its niqqud; a leading quote or emoji is
 * skipped), upper-cased: Backend's brandFromName (ef8ce568), so the preview
 * and the live widget draw the same letter.
 */
export function brandInitial(name: string): string {
  const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(name.trim());
  for (const { segment } of graphemes) {
    if (/^[\p{L}\p{N}]/u.test(segment)) return segment.toUpperCase();
  }
  return '';
}

/** sRGB → relative luminance (WCAG). */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255);
  const [r, g, b] = channels.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

const CREAM = '#FBF8F3';
const INK = '#2B2622';

/**
 * The text colour that reads on a main colour: design 7's cream or its ink,
 * whichever contrasts more. A pale main colour got white text on dev; the
 * live widget derives it the same way (chatcenter-widget.js inkOn).
 */
export function inkOn(hex: string): typeof CREAM | typeof INK {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return CREAM;
  const l = luminance(hex);
  const cream = (luminance(CREAM) + 0.05) / (l + 0.05);
  const ink = (l + 0.05) / (luminance(INK) + 0.05);
  return cream >= ink ? CREAM : INK;
}
