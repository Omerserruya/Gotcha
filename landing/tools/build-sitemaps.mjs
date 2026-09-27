/**
 * Three sitemaps and three robots files, generated from what was actually built.
 *
 * WHY IT READS `out/` AND NOT THE SOURCE
 * ---------------------------------------
 * A sitemap assembled from a list of routes is a second description of the
 * site, and a second description drifts: a page gets added, the list does not,
 * and the sitemap quietly omits it - or worse, keeps naming a page that no
 * longer builds, and every crawl logs a 404 against us. Reading the export
 * means the sitemap cannot say anything the site does not actually serve.
 *
 * WHY THREE
 * ---------
 * One build serves three public hostnames, and nginx rewrites each subdomain's
 * root onto a section of the same tree:
 *
 *   gotcha.co.il/about                 -> out/about.html
 *   help.gotcha.co.il/account/invite   -> out/help/account/invite.html
 *   trust.gotcha.co.il/privacy-policy  -> out/legal/privacy-policy.html
 *
 * A sitemap may only list URLs on its own host, so one file cannot serve all
 * three. They are written to out/sitemap.xml, out/help/sitemap.xml and
 * out/legal/sitemap.xml, and the vhosts serve each at its host's /sitemap.xml.
 *
 * The apex 302-redirects /help/* and /legal/* to the subdomains, so the
 * subdomain is the canonical home and no page is listed twice.
 *
 * Run after `next build` with NEXT_OUTPUT=export.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'out');

const clean = (raw, fallback) => (raw?.trim() || fallback).replace(/\/+$/, '');
const SITE = clean(process.env.NEXT_PUBLIC_MARKETING_URL, 'https://gotcha.co.il');
const HELP = clean(process.env.NEXT_PUBLIC_HELP_URL, 'https://help.gotcha.co.il');
const TRUST = clean(process.env.NEXT_PUBLIC_TRUST_URL, 'https://trust.gotcha.co.il');

if (!fs.existsSync(OUT)) {
  throw new Error('out/ does not exist - run the export first.');
}

/** Every .html the export produced, as a path with no extension. */
function pages(dir = OUT, prefix = '') {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === '_next' || entry.name === 'assets') continue;
      found.push(...pages(path.join(dir, entry.name), rel));
    } else if (entry.name.endsWith('.html')) {
      found.push(rel.replace(/\.html$/, ''));
    }
  }
  return found;
}

/**
 * Which host a built page belongs to, and in which language.
 *
 * `404` is excluded: it is a real file in the export and naming it in a sitemap
 * asks a crawler to index the error page.
 */
function classify(p) {
  if (p === '404' || p.endsWith('/404')) return null;
  const root = p === 'index' ? '' : p;

  const m = (section) => {
    const rest = root.slice(section.length + 1);
    const he = rest === 'he' || rest.startsWith('he/');
    return { rest: he ? rest.slice(2).replace(/^\//, '') : rest, lang: he ? 'he' : 'en' };
  };

  if (root === 'help' || root.startsWith('help/')) {
    const { rest, lang } = m('help');
    return { host: HELP, group: 'help', rest, lang };
  }
  if (root === 'legal' || root.startsWith('legal/')) {
    const { rest, lang } = m('legal');
    return { host: TRUST, group: 'legal', rest, lang };
  }
  const he = root === 'he' || root.startsWith('he/');
  return {
    host: SITE,
    group: 'site',
    rest: he ? root.slice(2).replace(/^\//, '') : root,
    lang: he ? 'he' : 'en',
  };
}

/**
 * How important a page is RELATIVE to its neighbours. Search engines treat this
 * as a hint about crawl order within one site and nothing more - it does not
 * affect ranking, and setting everything to 1.0 says nothing at all.
 */
function priority(group, rest) {
  if (rest === '') return 1.0;
  if (group === 'site') {
    if (['pricing', 'offer', 'why-gotcha'].includes(rest)) return 0.9;
    if (rest.startsWith('product/') || rest.startsWith('solutions/')) return 0.8;
    return 0.6;
  }
  if (group === 'help') return rest.includes('/') ? 0.6 : 0.5;
  return 0.4; // legal: real pages, rarely the answer to a search
}

const url = (host, rest, lang) => {
  const p = lang === 'he' ? (rest ? `he/${rest}` : 'he') : rest;
  return p ? `${host}/${p}` : host;
};

const built = pages().map(classify).filter(Boolean);

/** Group the two languages of one page so each can name the other. */
const groups = new Map();
for (const b of built) {
  const key = `${b.group}::${b.rest}`;
  if (!groups.has(key)) groups.set(key, { ...b, langs: new Set() });
  groups.get(key).langs.add(b.lang);
}

const lastmod = new Date().toISOString().slice(0, 10);

function render(entries) {
  const body = entries
    .map((e) => {
      const links = e.alternates
        .map((a) => `    <xhtml:link rel="alternate" hreflang="${a.hreflang}" href="${a.href}"/>`)
        .join('\n');
      return [
        '  <url>',
        `    <loc>${e.loc}</loc>`,
        links,
        `    <lastmod>${lastmod}</lastmod>`,
        `    <priority>${e.priority.toFixed(1)}</priority>`,
        '  </url>',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
${body}
</urlset>
`;
}

const byGroup = { site: [], help: [], legal: [] };

for (const g of [...groups.values()].sort((a, b) => a.rest.localeCompare(b.rest))) {
  // hreflang must be reciprocal and must include the page itself, or Google
  // discards the whole set. Both entries are built from one list so they cannot
  // disagree, and a page with only one language gets no set at all rather than
  // a set pointing at a URL that was never built.
  const alternates =
    g.langs.size > 1
      ? [
          { hreflang: 'en', href: url(g.host, g.rest, 'en') },
          { hreflang: 'he', href: url(g.host, g.rest, 'he') },
          { hreflang: 'x-default', href: url(g.host, g.rest, 'en') },
        ]
      : [];
  const p = priority(g.group, g.rest);
  for (const lang of ['en', 'he']) {
    if (!g.langs.has(lang)) continue;
    byGroup[g.group].push({ loc: url(g.host, g.rest, lang), alternates, priority: p });
  }
}

const TARGETS = [
  { group: 'site', dir: OUT, host: SITE, label: 'gotcha.co.il' },
  { group: 'help', dir: path.join(OUT, 'help'), host: HELP, label: 'help.gotcha.co.il' },
  { group: 'legal', dir: path.join(OUT, 'legal'), host: TRUST, label: 'trust.gotcha.co.il' },
];

for (const t of TARGETS) {
  fs.mkdirSync(t.dir, { recursive: true });
  fs.writeFileSync(path.join(t.dir, 'sitemap.xml'), render(byGroup[t.group]));
  fs.writeFileSync(
    path.join(t.dir, 'robots.txt'),
    [
      `# ${t.label}`,
      'User-agent: *',
      'Allow: /',
      '',
      `Sitemap: ${t.host}/sitemap.xml`,
      '',
    ].join('\n'),
  );
  const he = byGroup[t.group].filter((e) => e.loc.includes('/he')).length;
  console.log(
    `  ${t.label.padEnd(22)} ${String(byGroup[t.group].length).padStart(3)} urls  (${he} hebrew)`,
  );
}

const total = Object.values(byGroup).reduce((n, g) => n + g.length, 0);
if (total === 0) throw new Error('no pages found in out/ - refusing to write an empty sitemap');
console.log(`  ${'total'.padEnd(22)} ${String(total).padStart(3)} urls`);
