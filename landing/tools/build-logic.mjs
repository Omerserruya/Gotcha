/**
 * Wraps the design's DCLogic class as a React component, changing as little of
 * the authored source as possible: DCLogic already mirrors React's class API
 * (state, setState, componentDidMount/DidUpdate/WillUnmount), so the body ports
 * across untouched and only the class header, the HE_DICT source and render()
 * differ.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESIGN = path.join(ROOT, 'design');

/* The logic lives in the <script data-dc-script> block of the design file. */
const raw = fs.readFileSync(path.join(DESIGN, 'GOTCHA Landing.dc.html'), 'utf8');
const start = raw.indexOf('>', raw.indexOf('<script type="text/x-dc"')) + 1;
const OUT = path.join(ROOT, 'src/components/Landing.jsx');

let src = raw.slice(start, raw.lastIndexOf('</script>'));

/* HE_DICT came from a <script> that set a global; it is a module import now. */
const HE_LINE = "const HE_DICT = (window.GOTCHA_HE || {});";
if (!src.includes(HE_LINE)) throw new Error('HE_DICT declaration not found');
src = src.replace(HE_LINE, '');

/* DCLogic -> React.Component. Same lifecycle names, same setState contract. */
const CLASS_LINE = 'class Component extends DCLogic {';
if (!src.includes(CLASS_LINE)) throw new Error('Component class declaration not found');
src = src.replace(CLASS_LINE, 'class LandingLogic extends React.Component {');

/* Screenshot paths in the data are relative for the same reason the template's
   are: one URL. Root them so they resolve under /product/... and /solutions/... */
const assetHits = (src.match(/'assets\//g) || []).length;
src = src.replace(/'assets\//g, "'/assets/");

/* The design switches all 34 pages through `state.page` and never touches the
   URL. Seeding that one field from a prop is what lets a real route address a
   page; nothing else about the render changes. */
const PAGE_FIELD = "page: 'home',";
if (!src.includes(PAGE_FIELD)) throw new Error('state.page initialiser not found');
src = src.replace(PAGE_FIELD, "page: (this.props && this.props.initialPage) || 'home',");

/* Same for the language, so a section rendered in Hebrew brings the chrome
   with it instead of opening in English above Hebrew copy. */
const LANG_FIELD = "lang: 'en',";
if (!src.includes(LANG_FIELD)) throw new Error('state.lang initialiser not found');
src = src.replace(LANG_FIELD, "lang: (this.props && this.props.initialLang) || 'en',");

/* translate() swaps text nodes by dictionary lookup across the whole [dir]
   subtree. Wrapped around a hand-written section that would rewrite parts of a
   legal document from the marketing dictionary, so let a subtree opt out. Those
   sections manage their own language, document by document. */
const TRANSLATE_GUARD = "if (!p || p.closest('script,style')) return;";
if (!src.includes(TRANSLATE_GUARD)) throw new Error('translate() guard not found');
src = src.replace(
  TRANSLATE_GUARD,
  "if (!p || p.closest('script,style,[data-no-translate]')) return;",
);

/* Where "Login" goes. The design points it at #cta, so pressing it scrolled to
   the book-a-demo section instead of signing anyone in. links.app() resolves to
   /login on the application host. This was first made by hand in the generated
   Landing.jsx, where the next design:sync would have dropped it silently. */
const LOGIN_RETURN = "    return {\n      navItems,";
if (src.split(LOGIN_RETURN).length - 1 !== 1) throw new Error('renderVals return { navItems, not found exactly once');
src = src.replace(LOGIN_RETURN, `    return {
      // Where "Login" goes. It pointed at #cta, so pressing it scrolled to the
      // book-a-demo section instead of signing anyone in - the link looked
      // present and did the wrong thing, which is worse than being absent.
      //
      // \`links.app()\` already resolved to /login on the application host and
      // nothing used it. On a single-host or local setup it degrades to the
      // plain /login path, which is correct there.
      loginUrl: links.app(),
      navItems,`);

/* Omer's decision (2026-10-30): one launch offer across the site - the v8
   design's "first month free", until 31 December 2026 or 50 businesses. The
   older pages keep their own bar and drawer, with the v8 wording; the Hebrew
   for each new string comes from the v8 dictionary (build-he.mjs). Scoped to
   the `offer:` object of renderVals so no other use of these words moves. */
export const OLD_OFFER_SWAPS = [
  ["barText: 'First 3 months for $1 in total! For the first 50 businesses.'", "barText: 'First month free, no commitment! For the first 50 businesses.'"],
  ["tabLabel: '$1 for 3 months'", "tabLabel: 'First month free'"],
  ["title: 'Your first 3 months for $1!'", "title: 'Your first month free!'"],
  ["price: '$1', priceNote: 'in total, for 3 months, one payment'", "price: 'Free', priceNote: 'for the first month, no commitment'"],
  ["'1,000 credits every month'", "'1,000 credits for the month'"],
  ["'Billing and the three months start once you are connected'", "'The free month starts once you are connected'"],
  ["terms: 'Offer ends 31 October 2026 or when 50 businesses have joined, whichever comes first. After three months you continue on the plan and usage you choose. Regular pricing starts at $39 a month, excluding 18% VAT.'",
   "terms: 'Offer ends 31 December 2026 or when 50 businesses have joined, whichever comes first. After the first month you continue on the plan and usage you choose, with no commitment. Regular pricing starts at $39 a month, excluding 18% VAT.'"],
];
{
  const start = src.indexOf('\n      offer: {\n        badge:');
  const end = src.indexOf('hideBar:', start);
  if (start < 0 || end < 0) throw new Error('old offer object not found');
  let block = src.slice(start, end);
  for (const [from, to] of OLD_OFFER_SWAPS) {
    if (block.split(from).length - 1 !== 1) throw new Error(`old offer: expected one ${from.slice(0, 60)}`);
    block = block.replace(from, to);
  }
  src = src.slice(0, start) + block + src.slice(end);
}
/* The same offer in the older pages' navigation: their "$1 offer!" item takes
   the v8 navigation's own label for it. */
{
  const NAV_FROM = "['$1 offer!', null, 'offer']";
  if (src.split(NAV_FROM).length - 1 !== 1) throw new Error('old nav offer item not found');
  src = src.replace(NAV_FROM, "['First month free!', null, 'offer']");
}

/* `window.lucide` came from a CDN <script> and so is browser-only, but glyph()
   is called from renderVals() during render. Point both glyph() and
   paintIcons() at the bundled copy so the server renders the same icons. */
const lucideHits = (src.match(/window\.lucide/g) || []).length;
src = src.replace(/window\.lucide/g, 'getLucide()');

/* The runtime built `{...props, ...renderVals()}` and handed it to the template. */
const RENDER = `
  // dc-runtime: vals = { ...userProps, ...logic.renderVals() }
  __vals() {
    // leadPort: the lead cards' bindings (src/lib/old-lead.js), grafted by dc2jsx.
    return { ...this.props, ...(this.renderVals() || {}), leadPort: leadPort(this) };
  }

  // UrlSync gives state.page a real address. The design never touched the URL,
  // so without it every one of these pages is unlinkable.
  __render(view, extra) {
    let vals;
    try {
      vals = this.__vals();
    } catch (e) {
      console.error('renderVals():', e);
      return React.createElement('pre', { style: { padding: 24, color: '#8E3418' } }, String(e && e.stack || e));
    }
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(UrlSync, {
        page: this.state.page,
        alwaysNavigate: !!extra,
        onNavigate: (page) => this.setState({ page, menu: null }),
        lang: this.state.lang,
        onLang: this.props.onLang,
        // Back and Forward across a language boundary: the address is the
        // truth, so the landing follows it rather than the other way round.
        onUrlLang: (lang) => this.setState({ lang }),
      }),
      React.createElement(view, { v: vals, children: extra }),
    );
  }
`;

const last = src.lastIndexOf('}');
if (last < 0) throw new Error('no closing brace');
src = src.slice(0, last) + RENDER + src.slice(last);

const header = `/* Ported from the "GOTCHA Landing.dc.html" script block by tools/build-logic.mjs.
   The class body is the design's own source - keep edits there, not here. */
/* eslint-disable */
'use client';

import React from 'react';
import Template from '@/generated/Template';
import Chrome from '@/generated/Chrome';
import { HE_DICT } from '@/generated/he';
import { getLucide } from '@/lib/lucide';
import { links } from '@/lib/site';
import { leadPort } from '@/lib/old-lead';
import UrlSync from '@/components/UrlSync';

`;

fs.mkdirSync(path.join(ROOT, 'src/components'), { recursive: true });
const exports_ = `
/** The landing page: the design's chrome around the design's pages. */
export default class Landing extends LandingLogic {
  render() {
    return this.__render(Template, null);
  }
}

/**
 * The same chrome around something else - the Trust Center, a help article.
 *
 * Those sections are written by hand, but they are still the same website, so
 * they carry the real header and footer rather than a lookalike. A nav click
 * here is a real navigation: the landing's pages are separate documents from
 * where the reader is standing.
 */
export class LandingChrome extends LandingLogic {
  render() {
    return this.__render(Chrome, this.props.children);
  }
}
`;

fs.writeFileSync(OUT, header + src.trimStart() + exports_);

console.log('Landing.jsx:', (header + src).split('\n').length, 'lines');
console.log('window.lucide -> getLucide():', lucideHits, 'sites');
console.log('rooted asset paths:', assetHits);
