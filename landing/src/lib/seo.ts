/**
 * The addresses this site is indexed under.
 *
 * One build serves four hostnames - the marketing site, the Help Center, the
 * Trust Center and (in front of it) nginx, which rewrites each subdomain root
 * onto a section of the same tree. A sitemap and an hreflang tag have to name
 * the PUBLIC address a reader would use, not the internal path, so those two
 * views of the same page are kept apart here rather than guessed at each call
 * site.
 *
 * The apex 302-redirects /help/* and /legal/* to the subdomains, so the
 * subdomain is the canonical home of those pages and there is no duplicate
 * content to resolve - only one address to name.
 *
 * Overridable for a staging build; the defaults are production, because a
 * sitemap that silently names localhost is worse than no sitemap.
 */

const clean = (raw: string | undefined, fallback: string) =>
  (raw?.trim() || fallback).replace(/\/+$/, '');

export const SITE_ORIGIN = clean(process.env.NEXT_PUBLIC_MARKETING_URL, 'https://gotcha.co.il');
export const HELP_ORIGIN = clean(process.env.NEXT_PUBLIC_HELP_URL, 'https://help.gotcha.co.il');
export const TRUST_ORIGIN = clean(process.env.NEXT_PUBLIC_TRUST_URL, 'https://trust.gotcha.co.il');

/** Hebrew lives under /he on every host. `''` is that host's own root. */
export const HE = 'he';

export type SitemapEntry = {
  /** Absolute, public. */
  loc: string;
  /** Every language this page exists in, for the hreflang block. */
  alternates: { hreflang: string; href: string }[];
  /** 0..1. Relative only - it orders a crawl, it does not rank anything. */
  priority: number;
};

/**
 * One entry per language, each naming the other.
 *
 * Google wants the hreflang set to be reciprocal and to include the page
 * itself; a set that names a page which does not name it back is ignored
 * wholesale. Building both entries from one pair is the cheapest way to keep
 * that true.
 */
export function bilingual(origin: string, path: string, priority: number): SitemapEntry[] {
  const en = `${origin}${path ? `/${path}` : ''}`;
  const he = `${origin}/${HE}${path ? `/${path}` : ''}`;
  const alternates = [
    { hreflang: 'en', href: en },
    { hreflang: 'he', href: he },
    { hreflang: 'x-default', href: en },
  ];
  return [
    { loc: en, alternates, priority },
    { loc: he, alternates, priority },
  ];
}

/** The XML, with the xhtml namespace hreflang needs to be read at all. */
export function renderSitemap(entries: SitemapEntry[], lastmod: string): string {
  const body = entries
    .map((e) => {
      const links = e.alternates
        .map(
          (a) =>
            `    <xhtml:link rel="alternate" hreflang="${a.hreflang}" href="${a.href}"/>`,
        )
        .join('\n');
      return [
        '  <url>',
        `    <loc>${e.loc}</loc>`,
        links,
        `    <lastmod>${lastmod}</lastmod>`,
        `    <priority>${e.priority.toFixed(1)}</priority>`,
        '  </url>',
      ].join('\n');
    })
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
    '        xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    body,
    '</urlset>',
    '',
  ].join('\n');
}
