/**
 * dc2jsx - compiles the design canvas template in "GOTCHA Landing.dc.html"
 * into a React component, reproducing dc-runtime's semantics exactly.
 *
 * The conversion is mechanical on purpose: re-running it after a design change
 * reproduces the port, so the site stays a clone rather than a transcription.
 *
 *   <sc-for list="{{ e }}" as="x">  ->  {L(e).map((x, $index) => <Fragment key>)}
 *   <sc-if value="{{ e }}">         ->  {e ? <>...</> : null}
 *   {{ e }} in text                 ->  {I(e)}       (span.sc-interp, per runtime)
 *   {{ e }} as a whole attr value   ->  attr={e}     (raw value, per compileAttr)
 *   {{ e }} mixed into an attr      ->  attr={`..${A(e)}..`}
 *   style="..."                     ->  style={st("...")}
 *   style-<pseudo>="..."            ->  className generated into pseudo.css
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESIGN = path.join(ROOT, 'design');
import { createRequire } from 'node:module';
import { expandStyleSelectors } from './expand-style-selectors.mjs';

const require = createRequire(path.join(ROOT, 'package.json'));
const parse5 = require('parse5');

const SRC = path.join(DESIGN, 'GOTCHA Landing.dc.html');
const OUT_DIR = path.join(ROOT, 'src/generated');

/* ─────────── source slicing ─────────── */

const src = fs.readFileSync(SRC, 'utf8');
const inner = src.slice(src.indexOf('<x-dc>') + 6, src.indexOf('</x-dc>'));
const helmet = inner.slice(inner.indexOf('<helmet>') + 8, inner.indexOf('</helmet>'));
const template = inner.slice(inner.indexOf('</helmet>') + 9);

import { createEmitter } from './dc-emit.mjs';
import { cloneRebind, el, findAll, talkStates } from './lead-graft.mjs';

const { emitNode, pseudoRules, warnings } = createEmitter();

/* ─────────── run ─────────── */

const frag = parse5.parseFragment(template, { sourceCodeLocationInfo: false });

/* ─────────── desktop freeze ─────────── */

/**
 * The one place this port is deliberately NOT the design.
 *
 * The mobile export also finished four product-page sections whose copy had
 * been sitting in the design file for months with no markup to render it, and
 * it replaced the home hero's image-slot with a differently cropped photo. All
 * five show on desktop as well as on the phone. The desktop is signed off as it
 * stands and is not to move, so each one is admitted below the design's own
 * mobile breakpoint and held off above it.
 *
 * That is the whole deviation: nothing is dropped, nothing is rewritten, and
 * the phone still renders exactly what the design renders. Deleting the two
 * entries below and re-running restores the design in full on both.
 *
 * Everything here is asserted. If the design renames a flag or moves the hero,
 * the build stops rather than silently letting the desktop drift.
 */
const MOBILE_ONLY_CLASS = 'm-added';

/** sc-if flags whose sections are new on the desktop, and so are held to phones. */
const FROZEN_SECTIONS = ['feat.statsShown', 'feat.capsShown', 'feat.doesShown', 'feat.quoteShown'];

/** The hero the desktop keeps: the slot the new export removed, restored verbatim. */
const HERO_SLOT_ATTRS = [
  { name: 'id', value: 'hero-photo' },
  { name: 'shape', value: 'rect' },
  { name: 'placeholder', value: 'hero photograph: a real shop owner at work, warm daylight' },
  { name: 'style', value: 'animation:gken 30s ease-in-out infinite alternate;transform-origin:60% 50%' },
];

function addClass(node, name) {
  const cls = node.attrs.find((a) => a.name === 'class');
  if (cls) cls.value = `${cls.value} ${name}`.trim();
  else node.attrs.unshift({ name: 'class', value: name });
}

function walk(node, visit) {
  visit(node);
  // A snapshot: the hero restores a sibling node, and splicing into the array
  // being iterated makes the for-of hand back the node it was just given.
  for (const child of [...(node.childNodes ?? [])]) walk(child, visit);
}

function freezeDesktop(root) {
  const hits = new Map(FROZEN_SECTIONS.map((f) => [f, 0]));
  const inserts = [];
  let heroes = 0;

  walk(root, (node) => {
    if (node.tagName !== 'sc-if') return;
    const raw = node.attrs?.find((a) => a.name === 'value')?.value ?? '';
    const flag = /^\s*\{\{\s*([\s\S]+?)\s*\}\}\s*$/.exec(raw)?.[1];

    if (hits.has(flag)) {
      // sc-if compiles to a fragment, which has nothing to hang a class on, so
      // the class goes on each element the block renders.
      for (const child of node.childNodes ?? []) {
        if (child.tagName) addClass(child, MOBILE_ONLY_CLASS);
      }
      hits.set(flag, hits.get(flag) + 1);
      return;
    }

    if (flag !== 'isEn') return;
    const img = (node.childNodes ?? []).find((c) => c.tagName === 'img');
    if (!img) return;
    addClass(img, MOBILE_ONLY_CLASS);

    // The slot goes back in front of it, unconditional as it was. On a phone the
    // design's photo covers it; above the breakpoint the photo is gone and the
    // slot is what the desktop has always shown. Held until the walk is over so
    // the tree is not edited underneath it.
    inserts.push({ parent: node.parentNode, before: node });
    heroes++;
  });

  for (const { parent, before } of inserts) {
    parent.childNodes.splice(parent.childNodes.indexOf(before), 0, {
      nodeName: 'image-slot',
      tagName: 'image-slot',
      attrs: HERO_SLOT_ATTRS.map((a) => ({ ...a })),
      namespaceURI: 'http://www.w3.org/1999/xhtml',
      childNodes: [],
      parentNode: parent,
    });
  }

  for (const [flag, n] of hits) {
    if (n !== 1) throw new Error(`desktop freeze: expected exactly one <sc-if value="{{ ${flag} }}">, found ${n}`);
  }
  if (heroes !== 1) throw new Error(`desktop freeze: expected exactly one English hero, found ${heroes}`);
  return hits.size + heroes;
}

/* ─────────── lead cards ─────────── */

/**
 * Omer's decision (2026-10-30): every lead form on the site sends.
 *
 * The design's lead card ("Get a demo on your own business" - name, phone,
 * website, email, "Leave your details") appears 11 times written out and once drawn from data (the offer page's closing
 * card, from op.fields): 12 cards, reaching 60 pages.
 * It is not a form: the inputs are loose and the button is a styled <div>
 * with no handler, and the design has no sent state and no error line.
 *
 * So each card is changed in exactly four ways, all asserted:
 *   - the card is marked data-lead-card="<n>" and its inputs get names;
 *   - the <div> button becomes a control: role=button, tabindex=0, click and
 *     Enter/Space submit. Its look does not change;
 *   - the v8 design's own alert line goes above the button;
 *   - the v8 design's own sent card replaces the fields, inside the same box.
 * Both states come from tools/lead-graft.mjs, the same source the v8 home uses.
 * The bindings are `leadPort.c<n>.*`, filled by build-logic.mjs.
 */
// The fourth label is "Email (optional)" on every card but the design's own
// home card, which says "Email" (that card renders on no route here: / is the v8 home).
const LEAD_FIELDS = [[['Your name *'], 'name'], [['Phone *'], 'phone'], [['Website address *'], 'site'], [['Email (optional)', 'Email'], 'mail']];
const LEAD_CARDS = 12;
/** The offer page's closing card draws its fields from data (op.fields) instead of writing them out. */
const LEAD_FIELDS_DATA = "fields: ['Your name *', 'Phone *', 'Website address *', 'Email (optional)'],";
const textOf = (n) => (n.childNodes || []).map((c) => (c.nodeName === '#text' ? c.value : textOf(c))).join('');
const nodeAttr = (n, name) => (n.attrs || []).find((a) => a.name === name)?.value;

function graftLeadCards(root) {
  const states = talkStates(parse5, path.join(ROOT, 'design/home-v8/GOTCHA Website.dc.html'));
  const literal = (n) => {
    const inputs = (n.childNodes || []).filter((c) => c.tagName === 'input');
    return inputs.length === 4 && inputs.every((c, i) => LEAD_FIELDS[i][0].includes(nodeAttr(c, 'placeholder')));
  };
  const fromData = (n) => (n.childNodes || []).some((c) => c.tagName === 'sc-for' && /\{\{\s*op\.fields\s*\}\}/.test(nodeAttr(c, 'list') || ''));
  const cards = findAll(root, (n) => n.tagName === 'div' && (literal(n) || fromData(n)));
  // Its fields come from the logic's data, so their order is asserted there:
  // the handler reads an unnamed card's inputs by position.
  if (src.split(LEAD_FIELDS_DATA).length - 1 !== 1) throw new Error('lead cards: op.fields is no longer name, phone, website, email');
  if (cards.length !== LEAD_CARDS) throw new Error(`lead cards: expected ${LEAD_CARDS}, found ${cards.length}`);

  cards.forEach((card, n) => {
    const key = `leadPort.c${n}`;
    const kids = card.childNodes;
    kids.filter((c) => c.tagName === 'input').forEach((c, i) => c.attrs.unshift({ name: 'name', value: LEAD_FIELDS[i][1] }));
    // The button is the element right after the last field: a <div> drawn as a
    // button. Its label is "Leave your details" or a binding for it
    // ({{ chat.submit }}, {{ op.submit }}).
    const lastInput = kids.filter((c) => c.tagName === 'input' || c.tagName === 'sc-for').pop();
    const btn = kids.slice(kids.indexOf(lastInput) + 1).find((c) => c.tagName);
    if (!btn || btn.tagName !== 'div' || !/cursor:\s*pointer/.test(nodeAttr(btn, 'style') || '')) {
      throw new Error(`lead card ${n}: the element after the fields is not the design's div button`);
    }
    const label = textOf(btn).trim();
    if (label !== 'Leave your details' && !/^\{\{\s*(chat|op)\.submit\s*\}\}$/.test(label)) {
      throw new Error(`lead card ${n}: unexpected button label ${JSON.stringify(label)}`);
    }
    btn.attrs.push(
      { name: 'role', value: 'button' },
      { name: 'tabindex', value: '0' },
      { name: 'onclick', value: `{{ ${key}.submit }}` },
      { name: 'onkeydown', value: `{{ ${key}.key }}` },
    );
    kids.splice(kids.indexOf(btn), 0, cloneRebind(states.err, card, key));

    const formIf = el('sc-if', [{ name: 'value', value: `{{ ${key}.notSent }}` }], card);
    formIf.childNodes = kids.map((c) => ({ ...c, parentNode: formIf }));
    formIf.childNodes.forEach((c) => (c.childNodes || []).forEach((k) => { k.parentNode = c; }));
    const sentIf = el('sc-if', [{ name: 'value', value: `{{ ${key}.sent }}` }], card);
    sentIf.childNodes = states.sent.childNodes.map((k) => cloneRebind(k, sentIf, key));
    card.attrs.unshift({ name: 'data-lead-card', value: String(n) });
    card.childNodes = [formIf, sentIf];
  });
  return cards.length;
}

const leadCards = graftLeadCards(frag);

const frozen = freezeDesktop(frag);

/**
 * The host element carries `id="dc-root"`, because dc-runtime gives it one.
 *
 * support.js does `hostEl.id = "dc-root"` when it mounts, and the design's own
 * script reaches for it: fitMobile() walks `#dc-root *` to stack the columns
 * that are sized in pixels, unwrap rows that are too tight, and lift 10px
 * labels to something readable on a phone. Without the id that selector matched
 * nothing here, so none of it ran - the phone laid out from the CSS alone and
 * came out around a thousand pixels shorter than the design.
 *
 * Not a deviation: the one piece of the runtime's mount this port had missed.
 */
const hostNode = frag.childNodes.find((n) => n.tagName === 'div');
if (!hostNode) throw new Error('no host element to mark as #dc-root');
if (hostNode.attrs.some((a) => a.name === 'id')) throw new Error('the host element already has an id');
hostNode.attrs.unshift({ name: 'id', value: 'dc-root' });

const body = frag.childNodes.map((n) => emitNode(n, new Set(), 2)).filter(Boolean).join('\n');

/**
 * The design's footer links its legal documents at `href="#top"` - placeholders
 * that scroll to the top of the landing instead of opening anything. Those
 * documents exist now, so the placeholders are pointed at them.
 *
 * Keyed on the label and asserted, so that if the design renames or drops one
 * the build fails here rather than quietly shipping a dead link again.
 */
const LEGAL_LINKS = {
  Privacy: '/legal/privacy-policy',
  Terms: '/legal/terms-of-service',
  DPA: '/legal/dpa',
};

function linkLegal(jsx, { required }) {
  let out = jsx;
  for (const [label, href] of Object.entries(LEGAL_LINKS)) {
    const pattern = new RegExp(
      '(<a[^>]*?)href="#top"([^>]*>\\s*\\n\\s*\\{"' + label + '"\\})',
    );
    if (!pattern.test(out)) {
      if (!required) continue;
      throw new Error(
        `footer legal link "${label}" not found as an href="#top" placeholder. ` +
          'The design changed; update LEGAL_LINKS in tools/dc2jsx.mjs.',
      );
    }
    out = out.replace(pattern, `$1href="${href}"$2`);
  }

/**
 * The same footer row lists three documents but never the place they live, so
 * there is no way into the Trust Center from the bottom of the page. Add the
 * link ahead of them, matching the row's own markup exactly.
 */
  // The pseudo-class name is generated in walk order (scp0, scp1, ...), so it
  // moves whenever markup ahead of the footer gains a style-<pseudo>. Match
  // any generated class and give the new link the same one.
  const privacyAnchor = /( *)(<a className="(scp[0-9a-z]+)" href="\/legal\/privacy-policy"([^>]*)>)/;
  if (privacyAnchor.test(out)) {
    out = out.replace(
      privacyAnchor,
      `$1<a className="$3" href="/legal"$4>\n$1  {"Trust Center"}\n$1</a>\n$1{"\\n        "}\n$1$2`,
    );
  } else if (required) {
    throw new Error('privacy link not found - cannot place the Trust Center link beside it');
  }

  return out;
}

// The footer lives in both trees: the page renders it, and so does the chrome.
const linked = linkLegal(body, { required: true });

/**
 * The same markup, split into chrome and page.
 *
 * The root element's children are the bars and the header, then one <sc-if>
 * per page, then the footer. Everything outside that run of page conditionals
 * is chrome, and it is the chrome the hand-written sections need - the Trust
 * Center and the help articles should carry the site's real header and footer,
 * not an approximation of them.
 *
 * The boundary is found rather than hard-coded, so a page added to the design
 * lands in the body on its own.
 */
const root = frag.childNodes.find((n) => n.tagName === 'div');
if (!root) throw new Error('no root element in the template');

const isPageBlock = (n) =>
  n.tagName === 'sc-if' &&
  /^\s*\{\{\s*is[A-Z]/.test((n.attrs || []).find((a) => a.name === 'value')?.value ?? '');

const kids = root.childNodes || [];
const first = kids.findIndex(isPageBlock);
const last = kids.length - 1 - [...kids].reverse().findIndex(isPageBlock);
if (first < 0) throw new Error('no page blocks found - the chrome split has nothing to split on');

const rootOpen = emitNode({ ...root, childNodes: [] }, new Set(), 2).replace(/ \/>$|><\/div>$/, '>');
const emitRange = (from, to) =>
  kids.slice(from, to).map((n) => emitNode(n, new Set(), 4)).filter(Boolean).join('\n');

const chrome = linkLegal(
  `${rootOpen}\n${emitRange(0, first)}\n      {children}\n${emitRange(last + 1, kids.length)}\n    </div>`,
  { required: true },
);



fs.mkdirSync(OUT_DIR, { recursive: true });

const tsx = `/* GENERATED by tools/dc2jsx.mjs from "GOTCHA Landing.dc.html" - do not edit.
   Re-run \`node tools/dc2jsx.mjs\` after changing the design. */
/* eslint-disable */
import React from 'react';
import { st as $st, I as $I, L as $L, A as $A } from '@/lib/dc';
import ImageSlot from '@/components/ImageSlot';

export default function Template({ v: $v }) {
  return (
    <>
${linked}
    </>
  );
}
`;

fs.writeFileSync(path.join(OUT_DIR, 'Template.jsx'), tsx);

const chromeSrc = `/* GENERATED by tools/dc2jsx.mjs from "GOTCHA Landing.dc.html" - do not edit.
   The design's own header, bars and footer, with the page swapped for a hole.
   Re-run \`npm run design:sync\` after changing the design. */
/* eslint-disable */
import React from 'react';
import { st as $st, I as $I, L as $L, A as $A } from '@/lib/dc';

export default function Chrome({ v: $v, children }) {
  return (
${chrome}
  );
}
`;
fs.writeFileSync(path.join(OUT_DIR, 'Chrome.jsx'), chromeSrc);

/* The <helmet> <style> block is the design's global CSS: resets, keyframes and
   the RTL overrides. Several of those rules match on the literal text of an
   inline style attribute, so it goes out verbatim - never reformatted. It is
   generated rather than copied because the design edits it, and a stale copy
   fails silently: the page still renders, just with last week's rules. */
const helmetCss = /<style>([\s\S]*?)<\/style>/.exec(helmet)?.[1];
if (!helmetCss) throw new Error('no <style> block in <helmet>');

/**
 * The design targets elements by the literal text of their inline style, and
 * that text differs between its client rendering and this server-rendered one.
 * Expanding each selector into both spellings is what makes the design's own
 * mobile layout and RTL overrides actually apply here.
 */
const { css: designCss, expanded } = expandStyleSelectors(helmetCss.trim());

fs.writeFileSync(path.join(ROOT, 'src/app/globals.css'),
  '/* GENERATED by tools/dc2jsx.mjs from the <helmet> block of the design file.\n' +
  '   Do not edit and do not reformat: rules here match on the literal text of\n' +
  '   inline style attributes, and the selectors are expanded to cover both the\n' +
  '   spaced and unspaced spellings of that text. Re-run `npm run design:sync`. */\n' +
  designCss + '\n\n' +
  '/* style-<pseudo> attributes, as real classes. */\n' +
  pseudoRules.join('\n') + '\n');

console.log('Template.jsx :', tsx.split('\n').length, 'lines');
console.log('Chrome.jsx   :', chromeSrc.split('\n').length, 'lines (chrome + a hole for the page)');
console.log('globals.css  :', pseudoRules.length, 'pseudo rules +', designCss.split(String.fromCharCode(10)).length, 'lines of design CSS');
console.log('mobile       :', expanded, 'design selectors expanded to match server-rendered styles');
console.log('lead cards   :', leadCards, 'wired to /api/waitlist (leadPort.c0..c' + (leadCards - 1) + ')');
console.log('desktop     :', frozen, 'design additions admitted on phones only, so the desktop does not move');
if (warnings.length) {
  console.log('\nwarnings:');
  warnings.forEach((w) => console.log('  -', w));
}
