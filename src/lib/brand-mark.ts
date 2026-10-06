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
