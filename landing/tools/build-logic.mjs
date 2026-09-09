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

/* `window.lucide` came from a CDN <script> and so is browser-only, but glyph()
   is called from renderVals() during render. Point both glyph() and
   paintIcons() at the bundled copy so the server renders the same icons. */
const lucideHits = (src.match(/window\.lucide/g) || []).length;
src = src.replace(/window\.lucide/g, 'getLucide()');

/* The runtime built `{...props, ...renderVals()}` and handed it to the template. */
const RENDER = `
  // dc-runtime: vals = { ...userProps, ...logic.renderVals() }
  __vals() {
    return { ...this.props, ...(this.renderVals() || {}) };
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
