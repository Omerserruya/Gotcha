/**
 * Make <html lang dir> agree with the page it wraps.
 *
 * The design renders its own root as `<div id="dc-root" dir lang>` and sets
 * those two attributes correctly for every page: `rtl`/`he` under /he, /help/he
 * and /legal/he, `ltr`/`en` everywhere else. The document element does not
 * follow, because `<html>` is emitted by the ONE root layout every route in an
 * App Router export shares, and a shared layout has no route to ask.
 *
 * So every Hebrew page shipped as `<html lang="en">`. Search engines read the
 * document element, not a div inside the body, which meant the hreflang we just
 * published pointed at a page that declared itself English. hreflang saying "he"
 * and the page saying "en" is a contradiction the crawler resolves against us.
 *
 * This reads the answer the design already computed rather than deciding one
 * from the file's path: path rules would need updating every time a localized
 * section is added, and would silently be wrong for a page that moved.
 *
 * It is deliberately strict. A page with no dc-root, or with attributes it
 * cannot parse, fails the build rather than shipping a document whose declared
 * language is a guess.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = new URL('../out/', import.meta.url).pathname;

function walk(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) found.push(...walk(p));
    else if (name.endsWith('.html')) found.push(p);
  }
  return found;
}

const files = walk(OUT);
if (!files.length) throw new Error('sync-html-lang: no HTML in out/ - did the export run?');

let changed = 0;
const byLang = { he: 0, en: 0 };
const skipped = [];

for (const file of files) {
  const html = readFileSync(file, 'utf8');

  const root = html.match(/<div id="dc-root"[^>]*>/);
  if (!root) {
    // 404 and other bare documents have no design chrome; they stay English.
    skipped.push(file.slice(OUT.length));
    continue;
  }
  const dir = root[0].match(/\bdir="(rtl|ltr)"/);
  const lang = root[0].match(/\blang="(he|en)"/);
  if (!dir || !lang) {
    throw new Error(`sync-html-lang: dc-root in ${file.slice(OUT.length)} has no readable dir/lang`);
  }

  const open = html.match(/<html[^>]*>/);
  if (!open) throw new Error(`sync-html-lang: no <html> in ${file.slice(OUT.length)}`);

  const want = `<html lang="${lang[1]}" dir="${dir[1]}">`;
  byLang[lang[1]]++;
  if (open[0] === want) continue;

  writeFileSync(file, html.replace(open[0], want));
  changed++;
}

console.log(`  html lang/dir synced to dc-root: ${changed} rewritten, ${byLang.he} he, ${byLang.en} en`);
if (skipped.length) console.log(`  no dc-root (left as-is): ${skipped.join(', ')}`);
