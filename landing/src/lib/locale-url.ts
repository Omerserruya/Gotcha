import type { Locale } from '@/lib/site';

/**
 * The same page, in the other language, from wherever you are standing.
 *
 * This cannot be a fixed prefix, because one page has two path shapes
 * depending on which hostname served it. nginx rewrites each subdomain's root
 * onto a section of one tree:
 *
 *   help.gotcha.co.il/account/invite    -> out/help/account/invite.html
 *   gotcha.co.il/help/account/invite    -> the same file (and 302s to the above)
 *
 * So a link hard-coded to `/help/he/...` is correct on the apex and wrong on
 * the Help Center - where it would ask for `/help/help/he/...`. Deriving the
 * target from the path actually in the address bar is right on both, and stays
 * right if another section is added later.
 */
const SECTIONS = ['/help', '/legal'];

export function localeHref(pathname: string, to: Locale): string {
  // A bare "/" normalises to "" so that the Hebrew root is `/he` and not
  // `/he/` - two addresses for one page is exactly what this file exists to
  // avoid, and a trailing slash is enough to make a crawler believe it.
  let rest = pathname.replace(/\/+$/, '');
  let prefix = '';

  for (const s of SECTIONS) {
    if (rest === s || rest.startsWith(`${s}/`)) {
      prefix = s;
      rest = rest.slice(s.length);
      break;
    }
  }

  // Drop an existing language segment, whichever direction we are going.
  if (rest === '/he' || rest.startsWith('/he/')) rest = rest.slice(3);
  if (to === 'he') rest = `/he${rest}`;

  return `${prefix}${rest}` || '/';
}
