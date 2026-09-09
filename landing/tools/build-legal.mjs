/**
 * Compile docs/legal/{en,he}/*.md into a committed module the site can render.
 *
 * The markdown at the repository root is the single source of truth, but the
 * landing app cannot read it at runtime: it is outside the app directory and
 * outside whatever gets copied into an image. So it is projected into
 * src/generated/ and committed, the same way the application frontend does it.
 *
 *   node tools/build-legal.mjs           write the module
 *   node tools/build-legal.mjs --check   exit 1 if it would change
 *
 * Adapted from frontend/scripts/sync-legal-docs.mjs. The parsing rules are the
 * same on purpose - the same markdown has to render identically in both places
 * for as long as both exist.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_LEGAL_DOCS } from '../src/content/legal-registry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(ROOT, '..');
const DOCS = join(REPO, 'docs', 'legal');
const OUT = join(ROOT, 'src', 'generated', 'legal.js');

const LOCALES = ['en', 'he'];

/**
 * Phrases that mean a document is an internal record, not public copy. A
 * document carrying any of these is refused even when the registry marks it
 * public: two of the unpublished documents are candid engineering gap registers,
 * and shipping one to the web would publish a list of our own shortcomings.
 */
const INTERNAL_MARKERS = [
  'internal document',
  'מסמך פנימי',
  'known gap',
  'this is a known',
  'silently skipped',
  'not guaranteed complete',
];

function fail(message) {
  console.error(`\n  build-legal: ${message}\n`);
  process.exit(1);
}

/**
 * Relative document links become Trust Center routes. The markdown refers to
 * siblings as ./dpa.md because that is what works when the files are read as
 * files; on the web that has to be /legal/dpa. A link to a document we do not
 * publish is left as-is rather than turned into a 404.
 */
function rewriteLinks(body, published) {
  return body.replace(/\.\/([a-z0-9-]+)\.md/g, (whole, slug) =>
    published.includes(slug) ? `/legal/${slug}` : whole,
  );
}

/**
 * Split a document into prose and table blocks.
 *
 * Markdown tables are a GitHub extension, not CommonMark. Rather than take a
 * markdown-renderer dependency for them, the tables are parsed here and the page
 * renders real <table> elements - which also lets the wide subprocessor table
 * scroll on a phone instead of overflowing the document.
 */
function toBlocks(markdown) {
  const lines = markdown.split('\n');
  const blocks = [];
  let prose = [];

  const flushProse = () => {
    const text = prose.join('\n').trim();
    if (text) blocks.push({ kind: 'markdown', text });
    prose = [];
  };
  const cells = (line) =>
    line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

  for (let i = 0; i < lines.length; i++) {
    const isRow = /^\s*\|/.test(lines[i]);
    const isDivider = i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1]);

    if (isRow && isDivider) {
      flushProse();
      const head = cells(lines[i]);
      const rows = [];
      i += 2; // skip header and divider
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      i--; // the outer loop advances past the last consumed row
      blocks.push({ kind: 'table', head, rows });
      continue;
    }
    prose.push(lines[i]);
  }
  flushProse();
  return blocks;
}

/** Bracketed fill-ins such as [full legal name of the operating entity]. */
function findPlaceholders(body) {
  const out = new Set();
  // Negative lookahead for "(" so markdown links are not mistaken for these.
  for (const m of body.matchAll(/\[([^\]\n]{2,90})\](?!\()/g)) out.add(m[1].trim());
  return [...out];
}

function parseDoc(slug, locale, published) {
  const path = join(DOCS, locale, `${slug}.md`);
  if (!existsSync(path)) {
    fail(`missing ${locale}/${slug}.md - every published document needs both languages`);
  }

  const raw = readFileSync(path, 'utf8').replace(/\r\n/g, '\n').trim();

  const lower = raw.toLowerCase();
  const tripped = INTERNAL_MARKERS.filter((p) => lower.includes(p));
  if (tripped.length > 0) {
    fail(
      `${locale}/${slug}.md is marked public but reads as an internal record ` +
        `(found: ${tripped.join(', ')}).\n` +
        `  Either set audience:"internal" in src/content/legal-registry.js, or rewrite it for a public audience.`,
    );
  }

  const titleMatch = raw.match(/^#\s+(.+)$/m);
  if (!titleMatch) fail(`${locale}/${slug}.md has no H1 title`);
  const title = titleMatch[1].trim();

  // The H1 becomes the page heading, so it must not repeat inside the body.
  let body = raw.slice(raw.indexOf(titleMatch[0]) + titleMatch[0].length).trim();
  body = rewriteLinks(body, published);

  const dateMatch = raw.match(/(?:Effective date|תאריך תחולה):\s*(.+?)\.?\s*$/m);

  return {
    title,
    effectiveDate: dateMatch ? dateMatch[1].trim() : '',
    placeholders: findPlaceholders(body),
    blocks: toBlocks(body),
  };
}

function build() {
  if (!existsSync(DOCS)) fail(`docs/legal not found at ${DOCS}`);

  const published = PUBLIC_LEGAL_DOCS.map((d) => d.slug);
  const docs = {};
  for (const slug of published) {
    docs[slug] = {};
    for (const locale of LOCALES) docs[slug][locale] = parseDoc(slug, locale, published);
  }

  const banner =
    '/**\n' +
    ' * GENERATED by tools/build-legal.mjs from docs/legal/{en,he}/*.md.\n' +
    ' * Do not edit. Fix the markdown, then run `npm run legal:sync`.\n' +
    ' *\n' +
    ' * Committed on purpose: the markdown lives at the repository root, which the\n' +
    ' * app cannot reach at runtime.\n' +
    ' */\n\n';

  return banner + 'export const LEGAL_CONTENT = ' + JSON.stringify(docs, null, 2) + ';\n';
}

const next = build();
const check = process.argv.includes('--check');

if (check) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (current !== next) {
    fail('src/generated/legal.js is out of date with docs/legal. Run `npm run legal:sync`.');
  }
  console.log('legal: generated module matches docs/legal');
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, next);
  const count = PUBLIC_LEGAL_DOCS.length;
  console.log(`legal.js    : ${count} documents x ${LOCALES.length} languages`);
}
