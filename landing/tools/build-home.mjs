/**
 * build-home - compiles the home page of "GOTCHA Website.dc.html" (design
 * export 8) into the landing's `/` and `/he`.
 *
 * The rest of the site is still the older "GOTCHA Landing.dc.html", compiled by
 * dc2jsx.mjs and build-logic.mjs. This design replaces only the home, so it is
 * compiled into its own files and its own root layout, and nothing it emits is
 * read by the other pages:
 *
 *   design/home-v8/GOTCHA Website.dc.html   ->  src/generated/home/Template.jsx
 *                                                src/components/HomeLanding.jsx
 *                                                src/app/(home)/home.css
 *                                                src/generated/home/head.js
 *   design/home-v8/{he,gotcha-home-data,gotcha-en}.js -> src/generated/home/data.js
 *
 * The template goes through the same emitter as the old design (dc-emit.mjs),
 * so the runtime's semantics are reproduced by one implementation, not two.
 *
 * Every rewrite below is asserted: if the design renames a method or moves a
 * line, the build stops here rather than quietly shipping the design's own
 * single-URL behaviour (`?page=offer&lang=he`) on a site that has real
 * addresses.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createEmitter } from './dc-emit.mjs';
import { expandStyleSelectors } from './expand-style-selectors.mjs';
import { cloneRebind, el, findAll } from './lead-graft.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESIGN = path.join(ROOT, 'design/home-v8');
const require = createRequire(path.join(ROOT, 'package.json'));
const parse5 = require('parse5');

const SRC_NAME = 'GOTCHA Website.dc.html';
const GEN = path.join(ROOT, 'src/generated/home');
const ASSETS = '/assets/v8/';

const src = fs.readFileSync(path.join(DESIGN, SRC_NAME), 'utf8');
const inner = src.slice(src.indexOf('<x-dc>') + 6, src.indexOf('</x-dc>'));
const helmet = inner.slice(inner.indexOf('<helmet>') + 8, inner.indexOf('</helmet>'));
const template = inner.slice(inner.indexOf('</helmet>') + 9);

/** Replace exactly `n` occurrences, or stop the build. */
function swap(text, from, to, n = 1, what = from) {
  const hits = text.split(from).length - 1;
  if (hits !== n) throw new Error(`build-home: expected ${n} of ${JSON.stringify(what).slice(0, 90)}, found ${hits}`);
  return text.split(from).join(to);
}

/** Replace the one line matching `re` (a whole line), or stop the build. */
function swapLine(text, re, to, what) {
  const lines = text.split('\n');
  const idx = lines.map((l, i) => (re.test(l) ? i : -1)).filter((i) => i >= 0);
  if (idx.length !== 1) throw new Error(`build-home: expected one line for ${what}, found ${idx.length}`);
  lines[idx[0]] = to;
  return lines.join('\n');
}

const rootAssets = (s) => s.replace(/(['"(])assets\//g, `$1${ASSETS}`);

/* ─────────── template ─────────── */

const frag = parse5.parseFragment(template, { sourceCodeLocationInfo: false });

const attr = (n, name) => (n.attrs || []).find((a) => a.name === name)?.value;
const flagOf = (n) => /^\s*\{\{\s*([\s\S]+?)\s*\}\}\s*$/.exec(attr(n, 'value') ?? '')?.[1];

function walk(node, visit) {
  visit(node);
  for (const child of [...(node.childNodes ?? [])]) walk(child, visit);
}

const main = frag.childNodes.find((n) => n.tagName === 'div' && attr(n, 'data-site') === 'main');
if (!main) throw new Error('build-home: no <div data-site="main">');

/**
 * The design keeps every page on one URL and picks one with a flag read from
 * `?page=`. Only the home is ported; the other branches are cut here, at
 * compile time, so none of their markup ships. The list is asserted so a page
 * added to the design is a decision, not a silent extra.
 */
/**
 * The home's bottom form ("leave your details") had nowhere to send in the
 * design: its submit only calls preventDefault, and it has no sent state and
 * no error line. Omer's decision is that it sends a lead (src/lib/home-lead.mjs).
 *
 * The states it needs are not drawn here; they are taken from the design's own
 * contact-page form, which has both: the `role="alert"` line under the fields,
 * and the green-check card that replaces the form once it is sent. Both are
 * copied node for node from that form, bound to `ctaPort.*` instead of `tk.*`,
 * and the card sits in a box with the home form's own style so it occupies the
 * same place. The inputs gain `name` attributes so the handler can read them;
 * nothing visible changes until a submit.
 */
const talk = main.childNodes.find((n) => n.tagName === 'sc-if' && flagOf(n) === 'isTalk');
const tkErr = findAll(talk, (n) => n.tagName === 'sc-if' && flagOf(n) === 'tk.err');
const tkSent = findAll(talk, (n) => n.tagName === 'sc-if' && flagOf(n) === 'tk.sent');
if (tkErr.length !== 1 || tkSent.length !== 1) throw new Error(`build-home: talk form states moved (err ${tkErr.length}, sent ${tkSent.length})`);

const ctaForms = findAll(main, (n) => n.tagName === 'form' && attr(n, 'onsubmit') === '{{ cta.submit }}');
if (ctaForms.length !== 1) throw new Error(`build-home: expected one home CTA form, found ${ctaForms.length}`);
const ctaForm = ctaForms[0];
ctaForm.attrs.find((a) => a.name === 'onsubmit').value = '{{ ctaPort.submit }}';

const ctaInputs = ctaForm.childNodes.filter((n) => n.tagName === 'input');
const INPUT_NAMES = [['text', 'name'], ['tel', 'phone'], ['text', 'site'], ['email', 'mail']];
if (ctaInputs.length !== 4 || ctaInputs.some((n, i) => attr(n, 'type') !== INPUT_NAMES[i][0])) {
  throw new Error('build-home: the CTA form fields changed: ' + ctaInputs.map((n) => attr(n, 'type')).join(','));
}
ctaInputs.forEach((n, i) => n.attrs.unshift({ name: 'name', value: INPUT_NAMES[i][1] }));

const submitBtn = ctaForm.childNodes.find((n) => n.tagName === 'button' && attr(n, 'type') === 'submit');
if (!submitBtn) throw new Error('build-home: no submit button in the CTA form');
ctaForm.childNodes.splice(ctaForm.childNodes.indexOf(submitBtn), 0, cloneRebind(tkErr[0], ctaForm, 'ctaPort'));

const ctaParent = ctaForm.parentNode;
const formIf = el('sc-if', [{ name: 'value', value: '{{ ctaPort.notSent }}' }], ctaParent);
const sentIf = el('sc-if', [{ name: 'value', value: '{{ ctaPort.sent }}' }], ctaParent);
const sentBox = el('div', [{ name: 'style', value: attr(ctaForm, 'style') }], sentIf);
sentBox.childNodes = tkSent[0].childNodes.map((k) => cloneRebind(k, sentBox, 'ctaPort'));
sentIf.childNodes = [sentBox];
ctaParent.childNodes.splice(ctaParent.childNodes.indexOf(ctaForm), 1, formIf, sentIf);
formIf.childNodes = [ctaForm];
ctaForm.parentNode = formIf;

const PAGE_FLAGS = ['isHome', 'isTalk', 'isEcom', 'isWhy', 'isOffer', 'isPrice'];
const pageBlocks = main.childNodes.filter((n) => n.tagName === 'sc-if' && PAGE_FLAGS.includes(flagOf(n)));
const found = pageBlocks.map(flagOf).sort();
if (found.join() !== [...PAGE_FLAGS].sort().join()) {
  throw new Error(`build-home: page branches changed: ${found.join(', ')}`);
}
// Every branch ships: each is its own page here (/, /contact, /why-gotcha,
// /offer, /pricing, /solutions/ecommerce, /solutions/lead-handling), chosen by
// the `page` prop rather than by ?page=. See V8_PAGES in src/lib/v8-pages.ts.

/**
 * Links the design leaves as `href="#top"` placeholders, pointed at the page
 * this site already has for them. Keyed on the link's own text and counted, so
 * a renamed or dropped link fails the build. Each becomes a binding resolved at
 * render time (`portLinks.*`), because the address depends on the language.
 *
 * A label mapped to null is kept as the design has it: there is no page for it.
 */
const PLACEHOLDERS = {
  // footer, Product
  "אומניצ'אנל": ['feat-omnichannel', 1],
  'מעורבות ברשתות': ['feat-social', 1],
  'ברודקאסט בוואטסאפ': [null, 1],
  'העובד החדש שלכם': ['feat-employee', 1],
  'קופיילוט': ['feat-copilot', 1],
  'קול פיילוט (בטא)': ['feat-callpilot', 1],
  'מאגר ידע': ['feat-knowledge', 1],
  'אישורים': ['feat-approvals', 1],
  'לקוחות': ['feat-customers', 1],
  'סטודיו AI': ['feat-studio', 1],
  'אנליטיקס': ['feat-analytics', 1],
  "ווידג'ט לחנות": ['feat-widget', 1],
  'ערוצים': ['feat-channels', 1],
  // footer, Solutions
  'קוסמטיקה וטיפוח': ['sol-cosmetics', 1],
  'אופנה וביגוד': ['sol-fashion', 1],
  'בית וריהוט': ['sol-home', 1],
  'קליניקות ואסתטיקה': ['sol-clinics', 1],
  'מסעדות ועסקים מקומיים': ['sol-food', 1],
  'אלקטרוניקה': ['sol-electronics', 1],
  'תכשיטים ומתנות': ['sol-jewellery', 1],
  'איקומרס': ['sol-ecommerce', 1],
  'טיפול בלידים': ['sol-leads', 1],
  'מנהלים לבד': ['sol-owner', 1],
  'בקו הראשון': ['sol-agent', 1],
  // footer, Integrations
  'Shopify': ['feat-integrations', 1],
  'WooCommerce': ['feat-integrations', 1],
  'Zoho': ['feat-integrations', 1],
  'monday.com': ['feat-integrations', 1],
  'לכל האינטגרציות': ['feat-integrations', 1],
  // footer, Why GOTCHA
  'למה GOTCHA': ['why', 1],
  'מבצע, לא רק עונה': ['why', 1],
  'הגבולות שלכם, לכל פעולה': ['why', 1],
  'תמחור לפי שיחה': ['pricing', 1],
  // footer, Why GOTCHA and Company both list it
  'אבטחה': ['co-security', 2],
  // footer, Company
  'אודות': ['co-about', 1],
  'בלוג': ['co-blog', 1],
  'מרכז עזרה': ['help', 1],
  'קריירה': ['co-careers', 1],
  // footer, legal row
  'פרטיות': ['legal:privacy-policy', 1],
  'תנאי שימוש': ['legal:terms-of-service', 1],
  'הסכם עיבוד מידע': ['legal:dpa', 1],
};

const textOf = (n) => (n.childNodes || []).map((c) => (c.nodeName === '#text' ? c.value : textOf(c))).join('');
const placeholderHits = new Map(Object.keys(PLACEHOLDERS).map((k) => [k, 0]));
const portLinkKeys = new Map();
let loginLinks = 0;

walk(main, (n) => {
  if (n.tagName !== 'a' || attr(n, 'href') !== '#top') return;
  const href = n.attrs.find((a) => a.name === 'href');

  // "Log in" goes to the application, as it does on the rest of the site.
  if (attr(n, 'data-nav-login') !== undefined || /\{\{\s*nav\.login\s*\}\}/.test(textOf(n))) {
    href.value = '{{ portLinks.login }}';
    loginLinks++;
    return;
  }

  const label = textOf(n).trim();
  if (!placeholderHits.has(label)) return;
  placeholderHits.set(label, placeholderHits.get(label) + 1);
  const [page] = PLACEHOLDERS[label];
  if (!page) return;
  const key = 'p' + page.replace(/[^a-z0-9]/gi, '_');
  portLinkKeys.set(key, page);
  href.value = `{{ portLinks.${key} }}`;
});

for (const [label, n] of placeholderHits) {
  if (n !== PLACEHOLDERS[label][1]) throw new Error(`build-home: placeholder link "${label}": expected ${PLACEHOLDERS[label][1]}, found ${n}`);
}
if (loginLinks !== 2) throw new Error(`build-home: expected 2 login links (nav and phone menu), found ${loginLinks}`);

/**
 * Attributes the v8 template uses that React only accepts in its own spelling.
 * The DOM is the same either way (React writes them back hyphenated); without
 * the mapping React renders them and warns. Passed here rather than added to the
 * shared map so the older design's output does not move by a byte.
 */
const HOME_REACT_ATTRS = {
  inputmode: 'inputMode',
  'stroke-width': 'strokeWidth',
  'stroke-linejoin': 'strokeLinejoin',
  'stroke-linecap': 'strokeLinecap',
  'vector-effect': 'vectorEffect',
};

/**
 * The offer page's product shot is written `loading="lazy"`, but the design never
 * renders it lazily: its runtime creates the <img> in the browser and sets
 * src before loading, so the fetch starts at once. Served as HTML both arrive
 * together and the browser really defers it, so a reader scrolling to it sees
 * an empty box fill in that the design never shows. Dropped here, asserted as
 * the design's only lazy image, so the port loads it the way the design does.
 */
{
  const lazy = findAll(main, (n) => n.tagName === 'img' && attr(n, 'loading') === 'lazy');
  if (lazy.length !== 1 || !/home-clean\.png$/.test(attr(lazy[0], 'src') || '')) {
    throw new Error(`build-home: expected the offer page's one lazy image, found ${lazy.length}`);
  }
  lazy[0].attrs = lazy[0].attrs.filter((a) => a.name !== 'loading');
}

const { emitNode, pseudoRules, warnings } = createEmitter({ assetBase: ASSETS, reactAttrs: HOME_REACT_ATTRS, rootStyleAssets: true, runtimePseudo: true });
const body = frag.childNodes.map((n) => emitNode(n, new Set(), 2)).filter(Boolean).join('\n');

fs.mkdirSync(GEN, { recursive: true });
fs.writeFileSync(path.join(GEN, 'Template.jsx'), `/* GENERATED by tools/build-home.mjs from "design/home-v8/${SRC_NAME}" - do not edit.
   The home branch and the shared chrome; the design's other pages are cut at compile time.
   Re-run \`npm run home:sync\` after changing the design. */
/* eslint-disable */
import React from 'react';
import { st as $st, I as $I, L as $L, A as $A } from '@/lib/dc';

export default function HomeTemplate({ v: $v }) {
  return (
    <>
${body}
    </>
  );
}
`);

fs.writeFileSync(path.join(GEN, 'port-links.js'), `/* GENERATED by tools/build-home.mjs - the design's "#top" placeholders, by binding. */
export const PORT_LINK_PAGES = ${JSON.stringify(Object.fromEntries(portLinkKeys), null, 2)};
`);

/* ─────────── head: the helmet's inline scripts ─────────── */

/**
 * The helmet runs four scripts before the first paint. Two are ported verbatim
 * (scroll reset after a language switch, and the fx / nofx motion switch); the
 * CDN lucide is bundled instead; and the language one reads localStorage, which
 * this site replaces with the address: / is English and /he is Hebrew.
 */
const scripts = [...helmet.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].map((m) => ({ attrs: m[1], body: m[2].trim() }));
const inline = scripts.filter((s) => !/\bsrc=/.test(s.attrs));
const pick = (needle) => {
  const hit = inline.filter((s) => s.body.includes(needle));
  if (hit.length !== 1) throw new Error(`build-home: expected one helmet script with ${needle}, found ${hit.length}`);
  return hit[0].body;
};
const scrollTop = pick('gotcha-lang-top');
const motion = pick("prefers-reduced-motion: reduce");
pick('gotcha-home-lang');
if (inline.length !== 3) throw new Error(`build-home: helmet has ${inline.length} inline scripts, expected 3`);
const LANG_FROM_ADDRESS =
  '(function(){var d=document.documentElement;if(/^\\/he(\\/|$)/.test(location.pathname)){d.setAttribute("lang","he");}else{d.setAttribute("data-lang","en");d.setAttribute("lang","en");}})();';

const fontHref = /<link href="(https:\/\/fonts\.googleapis\.com\/css2[^"]+)"/.exec(helmet)?.[1];
if (!fontHref) throw new Error('build-home: no Google Fonts link in the helmet');

fs.writeFileSync(path.join(GEN, 'head.js'), `/* GENERATED by tools/build-home.mjs from the design's <helmet> - do not edit. */
export const FONT_HREF = ${JSON.stringify(fontHref.replace(/&amp;/g, '&'))};
/** Ported verbatim. */
export const SCROLL_TOP_SCRIPT = ${JSON.stringify(scrollTop)};
/** The address decides the language; the design read localStorage. */
export const LANG_SCRIPT = ${JSON.stringify(LANG_FROM_ADDRESS)};
/** Ported verbatim: fx unless reduced motion, nofx if the motion never gets ready. */
export const MOTION_SCRIPT = ${JSON.stringify(motion)};
`);

/* ─────────── CSS ─────────── */

const helmetCss = /<style>([\s\S]*?)<\/style>/.exec(helmet)?.[1];
if (!helmetCss) throw new Error('build-home: no <style> block in <helmet>');
const { css: designCss, expanded } = expandStyleSelectors(rootAssets(helmetCss.trim()));
const CSS_OUT = path.join(ROOT, 'src/app/(v8)/v8.css');
fs.mkdirSync(path.dirname(CSS_OUT), { recursive: true });
fs.writeFileSync(CSS_OUT,
  '/* GENERATED by tools/build-home.mjs from the <helmet> block of design/home-v8.\n' +
  '   Loaded by the home\'s own root layout only. Do not edit; re-run `npm run home:sync`. */\n' +
  designCss + '\n\n/* style-<pseudo> attributes, as real classes. */\n' + pseudoRules.join('\n') + '\n');

/* ─────────── data ─────────── */

/**
 * The three data files are scripts that assign to `window`. They run here
 * verbatim against a local `window`, so not a character of their content is
 * rewritten except the asset roots.
 */
/**
 * Omer's decision: the launch offer runs to the end of the year, not to
 * 31 October. Changed in the source text, in both languages and every place it
 * appears (the drawer's fine print, and the offer page's terms that share the
 * same dictionary), keeping "or when 50 businesses have joined". The English is
 * also the dictionary's key, so key, value and the logic's own string move
 * together; the counts are asserted.
 */
const OFFER_DATE = [
  { file: 'he.js', from: '31 October 2026', to: '31 December 2026', n: 3 },
  { file: 'he.js', from: 'ב-31 באוקטובר 2026', to: 'ב-31 בדצמבר 2026', n: 3 },
  { file: 'logic', from: '31 October 2026', to: '31 December 2026', n: 2 },
];
const dataOverride = (f, text) => OFFER_DATE.filter((o) => o.file === f).reduce((t, o) => swap(t, o.from, o.to, o.n), text);

const dataParts = ['he.js', 'gotcha-home-data.js', 'gotcha-en.js'].map((f) => {
  const text = dataOverride(f, fs.readFileSync(path.join(DESIGN, f), 'utf8'));
  return `/* ── ${f} ── */\n${rootAssets(text)}`;
});
fs.writeFileSync(path.join(GEN, 'data.js'), `/* GENERATED by tools/build-home.mjs from design/home-v8/{he,gotcha-home-data,gotcha-en}.js - do not edit. */
/* eslint-disable */
const window = {};
${dataParts.join('\n')}
export const GOTCHA_HE = window.GOTCHA_HE;
export const GOTCHA_HOME = window.GOTCHA_HOME;
export const GOTCHA_EN = window.GOTCHA_EN;
`);

/* ─────────── logic ─────────── */

const start = src.indexOf('>', src.indexOf('<script type="text/x-dc"')) + 1;
let logic = src.slice(start, src.lastIndexOf('</script>'));

logic = swap(logic, 'class Component extends DCLogic {', 'class HomeLogic extends React.Component {');
logic = dataOverride('logic', logic);

/**
 * Omer's decision (2026-10-30): the pricing page keeps the design's layout and
 * copy, with the numbers of today's /pricing, which are billing's, in dollars.
 * Each change is listed in PRICING_OVERRIDES and asserted against prVals();
 * every other number and line on the page is the design's.
 */
export const PRICING_OVERRIDES = [
  // Dollars by default in both languages (the design opened Hebrew in shekels).
  ["cur = s.prCur || (en ? 'usd' : 'ils')", "cur = s.prCur || 'usd'"],
  // Yearly is twelve months, as /pricing sells it: no 15% discount, no savings line.
  ["const t = yr ? Math.round(m * 12 * 0.85 / 10) * 10 - 1 : m;", "const t = yr ? m * 12 : m;"],
  ["p.hasSave = yr;", "p.hasSave = false;"],
  ["L('שנתי · 15% הנחה', 'Yearly · 15% off')", "L('שנתי', 'Yearly')"],
  ["L('חיוב פעם בשנה, חשבונית אחת, 15% הנחה לעומת חודשי', 'Billed once a year, one invoice, 15% off monthly')",
   "L('חיוב פעם בשנה, חשבונית אחת', 'Billed once a year, one invoice')"],
  // No stated 3.1 rate.
  ["L(' · המחיר בשקלים מוערך לפי שער 3.1', ' · Shekel prices are an estimate at a 3.1 rate')",
   "L(' · המחיר בשקלים מוערך', ' · Shekel prices are an estimate')"],
  ["'המחירים נקבעים בדולר. המחיר בשקלים מחושב לפי שער של 3.1 ומעוגל, ומוצג להערכה.",
   "'המחירים נקבעים בדולר. המחיר בשקלים מחושב בהמרה ומעוגל, ומוצג להערכה."],
  ["'Prices are set in US dollars. Shekel amounts are a conversion at a 3.1 rate, rounded, and shown as an estimate.",
   "'Prices are set in US dollars. Shekel amounts are a conversion, rounded, and shown as an estimate."],
  // Included credits as billing grants them: AI Team 200 a tier, Call Pilot 200 chat + 250 voice.
  ["(TIERS[ix.pai] * 25 * 7)", "(TIERS[ix.pai] * 200)"],
  ["(TIERS[ix.ccp] * 25 * 7 + TIERS[ix.cai] * 25 * 10)", "(TIERS[ix.ccp] * 200 + TIERS[ix.cai] * 250)"],
];
{
  const start = logic.indexOf('  prVals() {');
  const end = logic.indexOf('\n  async initPrice() {', start);
  if (start < 0 || end < 0) throw new Error('build-home: prVals() not found');
  let block = logic.slice(start, end);
  for (const [from, to] of PRICING_OVERRIDES) block = swap(block, from, to, 1, from);
  logic = logic.slice(0, start) + block + logic.slice(end);
}

// Omer's decision (2026-10-30): no en or em dashes in the UI. The design builds
// the Hebrew H1 by turning the English comma into ' – '; it becomes a hyphen
// with spaces. The same string is the hero's aria-label and the source of the
// split words, so all three change together.
logic = swap(logic, "T('Every customer interaction, end to end').replace(/,\\s*/, ' \u2013 ')", "T('Every customer interaction, end to end').replace(/,\\s*/, ' - ')");

// Omer's decision: on a first visit the offer drawer waits for the cookie card
// to be answered, so the two never open on top of each other. With a decision
// already stored, consentDecided() is true and the drawer is the design's.
logic = swap(logic, '    if (this.autoOpened || this.state.offerOpen) return;\n', '    if (this.autoOpened || this.state.offerOpen || !consentDecided()) return;\n');

// The data is imported, so it is ready at the first render on the server too.
logic = swap(logic, 'ready: !!(window.GOTCHA_HE && window.GOTCHA_HOME)', 'ready: true');
logic = swap(logic, 'window.GOTCHA_HE', '__D.GOTCHA_HE', 3);
logic = swap(logic, 'window.GOTCHA_HOME', '__D.GOTCHA_HOME', 4);
logic = swap(logic, 'window.GOTCHA_EN', '__D.GOTCHA_EN', 1);

// Only the home is ported: every other page flag is false, at any address.
// The design picks a page from ?page=; here the route does, through `page`.
logic = swapLine(logic, /^  EMBED = \/embed=1\/\.test\(location\.search\);$/, '  EMBED = false;', 'EMBED');
for (const [name, re] of [['TALK', 'talk'], ['ECOM', 'ecommerce'], ['LEADS', 'leads'], ['WHY', 'why'], ['OFFER', 'offer'], ['PRICE', 'pricing']]) {
  logic = swapLine(logic, new RegExp(`^  ${name} = /.*${re}.*\\.test\\(location\\.search\\);$`), `  ${name} = !!(this.props && this.props.page === '${re}');`, name);
}

// The language is the address, not ?lang= or localStorage.
logic = swapLine(logic, /^  EN_ON = \(\(\) => \{/, "  EN_ON = !!(this.props && this.props.lang === 'en');", 'EN_ON');

// Every link the design builds as `?page=<key>&lang=` goes to that page's real address.
// A link to the page you are on is #top, as the design has it; every other
// page key goes to its address on this site (src/lib/home-links.ts).
const HREF = (key) => `homeHref(${key}, this.EN_ON ? 'en' : 'he', this.props && this.props.page)`;
logic = swapLine(logic, /^  pageUrl\(p\) \{/, `  pageUrl(p) { return ${HREF('p')}; }`, 'pageUrl');
logic = swapLine(logic, /^  whyUrl\(\) \{/, `  whyUrl() { return ${HREF("'why'")}; }`, 'whyUrl');
logic = swapLine(logic, /^  talkUrl\(\) \{/, `  talkUrl() { return ${HREF("'co-chat'")}; }`, 'talkUrl');
logic = swapLine(logic, /^  ecomUrl\(\) \{/, `  ecomUrl() { return ${HREF("'sol-ecommerce'")}; }`, 'ecomUrl');
logic = swapLine(logic, /^  homeUrl\(\) \{/, `  homeUrl() { return ${HREF("'home'")}; }`, 'homeUrl');

// The toggle keeps the design's bookkeeping and moves to the other address
// instead of reloading this one with ?lang=.
logic = swapLine(logic, /^  setLang\(l\) \{/,
  "  setLang(l) { try { localStorage.setItem('gotcha-home-lang', l); localStorage.setItem('gotcha-lang', l); sessionStorage.setItem('gotcha-lang-top', '1'); } catch (e) {} if ('scrollRestoration' in history) history.scrollRestoration = 'manual'; location.href = v8PageHref(this.props && this.props.page, l); }",
  'setLang');

// The CDN scripts are bundled (src/lib/home-vendor.js): production's CSP
// allows scripts from 'self' only, and its landing vhost 301s any .js outside
// /_next/ to the application host.
logic = swap(logic, "this.load('https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js')", "loadVendor('gsap')", 6);
logic = swap(logic, "this.load('https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/ScrollTrigger.min.js')", "loadVendor('ScrollTrigger')", 5);
logic = swap(logic, "this.load('https://cdn.jsdelivr.net/npm/lenis@1.1.13/dist/lenis.min.js')", "loadVendor('Lenis')", 5);

// lucide is bundled, as on the rest of the site.
logic = swap(logic, 'window.lucide', 'getLucide()', 1);

logic = rootAssets(logic);

const last = logic.lastIndexOf('}');
logic = logic.slice(0, last) + `
  // dc-runtime: vals = { ...userProps, ...logic.renderVals() }, plus the
  // addresses this site gives the design's placeholder links.
  render() {
    let vals;
    try {
      vals = { ...this.props, ...(this.renderVals() || {}), portLinks: portLinks(this.EN_ON ? 'en' : 'he'), ctaPort: this.ctaPort() };
    } catch (e) {
      console.error('renderVals():', e);
      return React.createElement('pre', { style: { padding: 24, color: '#8E3418' } }, String((e && e.stack) || e));
    }
    const tree = HomeTemplate({ v: vals });
    // enPass(), applied to the tree instead of the DOM, so English is in the
    // server-rendered page and not swapped in after it paints.
    return this.EN_ON ? enTree(tree, (s) => this.toEn(s)) : tree;
  }
` + logic.slice(last);

fs.writeFileSync(path.join(ROOT, 'src/components/V8Landing.jsx'), `/* Ported from the "${SRC_NAME}" script block by tools/build-home.mjs - do not edit.
   The class body is the design's own source; keep edits there, or in the compiler. */
/* eslint-disable */
'use client';

import React from 'react';
import HomeTemplate from '@/generated/home/Template';
import * as __D from '@/generated/home/data';
import { getLucide } from '@/lib/lucide';
import { enTree } from '@/lib/en-tree';
import { homeHref, portLinks, v8PageHref } from '@/lib/home-links';
import { V8_PAGES } from '@/lib/v8-pages';
import { consentDecided, onConsentDecided } from '@/lib/consent';
import { leadFromForm, sendLead, SEND_FAILED } from '@/lib/home-lead.mjs';
import { loadVendor } from '@/lib/home-vendor';

/*
 * The design ran in a browser only. Rendered on the server too, the two
 * globals its render path touches are shadowed here: on the client they ARE the
 * browser's objects (so \`location.href = …\` still navigates), and on the
 * server they are inert stand-ins. Lifecycle methods and handlers only ever run
 * in the browser.
 */
const window = typeof globalThis.window !== 'undefined' ? globalThis.window : { innerHeight: 900, innerWidth: 1440 };
const location = typeof globalThis.location !== 'undefined' ? globalThis.location : { pathname: '/', search: '', href: '/' };

${logic.trimStart()}

/** A v8 page - the home, contact, why, offer, pricing, ecommerce or leads - in the design's chrome. */
export default class V8Landing extends HomeLogic {
  componentDidMount() {
    // The exported HTML already carries these (tools/sync-html-lang.mjs); this
    // covers \`next dev\`, which serves the layout without the rewrite.
    const d = document.documentElement;
    d.setAttribute('lang', this.EN_ON ? 'en' : 'he');
    if (this.EN_ON) d.setAttribute('data-lang', 'en'); else d.removeAttribute('data-lang');
    // The drawer's auto-open waits for the cookie card; once it is answered,
    // run the design's own check again so a reader already scrolled past the
    // fold gets the drawer then, not on some later scroll.
    this.offConsent = onConsentDecided(() => this.offerAuto());
    return super.componentDidMount();
  }

  componentWillUnmount() {
    if (this.offConsent) this.offConsent();
    super.componentWillUnmount();
  }

  /**
   * The hero's website field (Omer's decision): its own check and shake are the
   * design's; a valid address now carries on to the bottom form instead of
   * firing an event nothing listens to. The form gets the website, the reader
   * gets the name field, and the lead is sent with source landing-home-hero for
   * as long as that website is the one in the field. The scroll and focus are
   * the design's own tkToForm(): 120px above the form, 1.4s, focus without
   * scrolling once it lands.
   */
  goOnboarding(site) {
    super.goOnboarding(site);
    const v = String(site || '').trim();
    const form = document.querySelector('#cta form');
    const target = form || document.querySelector('#cta [data-tk-ok]');
    if (!target) return;
    if (form) {
      const siteInput = form.elements.site;
      if (siteInput) siteInput.value = v;
      this.heroSite = v;
    }
    const y = target.getBoundingClientRect().top + window.scrollY - 120;
    if (this.lenis) this.lenis.scrollTo(y, { duration: 1.4 }); else window.scrollTo(0, y);
    setTimeout(() => { const i = form && form.elements.name; if (i) i.focus({ preventScroll: true }); }, 1500);
  }

  /**
   * The contact form the talk, why, offer and pricing pages draw (tk.*). The
   * design checks it and then shows its sent card; here the lead is sent in
   * between, with the page's own source (src/lib/v8-pages.ts). An incomplete
   * form is the design's own path, untouched. A failure keeps the form and its
   * values and shows the design's alert line with the send-failed sentence.
   */
  async tkSubmit(ev) {
    ev.preventDefault();
    if (this.tkBusy) return;
    const f = ev.currentTarget, v = (n) => String((f.elements[n] || {}).value || '');
    const page = (this.props && this.props.page) || 'home';
    const lead = leadFromForm({ name: v('name'), phone: v('phone'), site: v('site'), mail: v('mail') }, V8_PAGES[page] && V8_PAGES[page].source);
    // Incomplete, or a page with no source: the design's own handling.
    if (!lead || !lead.source) return super.tkSubmit({ preventDefault() {}, currentTarget: f });
    this.tkBusy = true;
    if (this.state.tkFail) this.setState({ tkFail: false });
    const result = await sendLead(lead);
    this.tkBusy = false;
    if (result !== 'sent') { this.setState({ tkFail: true, tkErr: null }); return; }
    super.tkSubmit({ preventDefault() {}, currentTarget: f });
  }

  tkVals() {
    const v = super.tkVals();
    if (this.state.tkFail) {
      v.err = true;
      v.errText = SEND_FAILED[this.EN_ON ? 'en' : 'he'];
    }
    const clear = v.clearErr;
    v.clearErr = () => { if (this.state.tkFail) this.setState({ tkFail: false }); clear(); };
    return v;
  }

  /** The bottom form's bindings: the contact-page form's states and copy, from tkVals(). */
  ctaPort() {
    const tk = this.tkVals(), s = this.state;
    return {
      submit: (ev) => this.ctaSubmit(ev),
      notSent: !s.ctaSent, sent: !!s.ctaSent,
      err: !!s.ctaErr,
      errText: s.ctaErr === 'send' ? SEND_FAILED[this.EN_ON ? 'en' : 'he'] : tk.errText,
      okTitle: tk.okTitle, okBody: tk.okBody, pick: tk.pick,
    };
  }

  /**
   * Same shape as the design's tkSubmit(): read the fields, refuse an
   * incomplete form with the design's shake, otherwise send. A failure keeps
   * the form and its values on screen with the error line; nothing is dropped
   * silently.
   */
  async ctaSubmit(ev) {
    ev.preventDefault();
    if (this.ctaBusy) return;
    const f = ev.currentTarget, v = (n) => String((f.elements[n] || {}).value || '');
    const fromHero = !!this.heroSite && v('site').trim() === this.heroSite;
    const lead = leadFromForm({ name: v('name'), phone: v('phone'), site: v('site'), mail: v('mail') }, fromHero ? 'landing-home-hero' : 'landing-home-cta');
    if (!lead) {
      this.setState({ ctaErr: 'fields' });
      const g = window.gsap;
      if (g && !this.reduce) g.fromTo(f, { x: 0 }, { keyframes: { x: [-9, 8, -6, 4, -2, 0] }, duration: 0.5, ease: 'power2.out' });
      return;
    }
    this.ctaBusy = true;
    if (this.state.ctaErr) this.setState({ ctaErr: null });
    const result = await sendLead(lead);
    this.ctaBusy = false;
    this.setState(result === 'sent' ? { ctaSent: true, ctaErr: null } : { ctaErr: 'send' });
  }
}
`);

console.log('home Template.jsx :', body.split('\n').length, 'lines');
console.log('home.css          :', pseudoRules.length, 'pseudo rules,', expanded, 'selectors expanded');
console.log('placeholder links :', [...placeholderHits.values()].reduce((a, b) => a + b, 0), 'matched,', portLinkKeys.size, 'distinct targets, +', loginLinks, 'login');
if (warnings.length) {
  console.log('\nwarnings:');
  warnings.forEach((w) => console.log('  -', w));
}
