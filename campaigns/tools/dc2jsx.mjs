/**
 * dc2jsx - compiles the <x-dc> template of a campaign design file into a React
 * component, reproducing dc-runtime's semantics exactly.
 *
 * WHY THIS EXISTS BESIDE landing/tools/dc2jsx.mjs
 * ------------------------------------------------
 * That one is the same idea, and this is not a fork of it. It carries a large
 * amount of machinery this design has no use for - sc-for, image slots, the
 * chrome/page split, the Hebrew dictionary, the desktop freeze, the legal-link
 * rewriting - all of it specific to a 634KB marketing site built from 34 pages.
 * The campaign file uses a strict subset: sc-if, {{ }} interpolation, `style`
 * and `style-<pseudo>`. Nothing else.
 *
 * Importing the other file was the first thing tried and does not work: it does
 * all of its work at module scope, so importing it runs the marketing build.
 * Refactoring it into a function would mean editing a file another branch is
 * actively changing. What is left is a small compiler that reads that one as a
 * specification and implements the parts this design actually uses.
 *
 * The conversion is mechanical on purpose: re-running it after a design change
 * reproduces the port, so the page stays a clone rather than a transcription.
 *
 *   <sc-if value="{{ e }}">     ->  {e ? <>...</> : null}
 *   {{ e }} in text             ->  {$I(e)}   (span.sc-interp, per the runtime)
 *   {{ e }} as a whole attr     ->  attr={e}  (raw value, per compileAttr)
 *   {{ e }} mixed into an attr  ->  attr={`..${$A(e)}..`}
 *   style="..."                 ->  style={$st("...")}
 *   style-<pseudo>="..."        ->  a generated class in the emitted stylesheet
 *
 * Usage:  node tools/dc2jsx.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESIGN = path.join(ROOT, 'design');
const SRC = path.join(DESIGN, 'GOTCHA Campaign Landing.dc.html');
const OUT_DIR = path.join(ROOT, 'src/generated');
const CSS_OUT = path.join(ROOT, 'src/app/campaign.css');

/**
 * parse5, from wherever this repo happens to have it.
 *
 * It is not declared in any package.json - it arrives as a transitive
 * dependency - so there is no single path that is guaranteed. Adding it as a
 * real dependency is not on the table (this repo does not take new ones), and
 * it is not needed at build time anyway: everything this script writes is
 * COMMITTED, so `next build` never runs it. Only a developer re-syncing the
 * design does, and they have the repo installed.
 *
 * A real HTML5 parser is worth this small indignity. The alternative in reach
 * was `next/dist/compiled/node-html-parser`, which is an approximation living
 * at a path Next is free to move between patch releases.
 */
function loadParse5() {
  /**
   * The MAIN checkout, when this file is running inside a git worktree.
   *
   * This repo is worked on through a dozen worktrees at once, and a worktree
   * has no node_modules of its own - the packages are installed once in the
   * main checkout. `git rev-parse --git-common-dir` points at the main .git
   * from anywhere, and its parent is that checkout. Without this the script
   * only ever worked in one of the twelve places it might be run from.
   */
  let main = null;
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    if (common) main = path.dirname(common);
  } catch {
    /* not a git checkout, or no git. The other candidates still apply. */
  }

  const candidates = [
    path.join(ROOT, 'package.json'),                       // if ever declared here
    path.join(ROOT, '..', 'package.json'),                 // repo root, beside this app
    path.join(ROOT, '..', 'frontend', 'package.json'),     // where it actually is today
    path.join(ROOT, '..', 'landing', 'package.json'),
    ...(main
      ? [
          path.join(main, 'package.json'),
          path.join(main, 'frontend', 'package.json'),
          path.join(main, 'landing', 'package.json'),
        ]
      : []),
  ];
  for (const from of candidates) {
    try {
      return createRequire(from)('parse5');
    } catch {
      /* try the next one */
    }
  }
  throw new Error(
    'parse5 not found in this repo. It is a transitive dependency rather than a\n' +
      'declared one; `npm install` in frontend/ brings it back. Looked in:\n  ' +
      candidates.join('\n  '),
  );
}
const parse5 = loadParse5();

/* ─────────── source slicing ─────────── */

const src = fs.readFileSync(SRC, 'utf8');
const inner = src.slice(src.indexOf('<x-dc>') + 6, src.indexOf('</x-dc>'));
const helmet = inner.slice(inner.indexOf('<helmet>') + 8, inner.indexOf('</helmet>'));
const template = inner.slice(inner.indexOf('</helmet>') + 9);
if (!template.trim()) throw new Error('empty template - is this a .dc.html file?');

/* ─────────── pseudo-class sheet (support.js: createPseudoSheet) ─────────── */

const pseudoRules = [];
const pseudoCache = new Map();

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** support.js: importantify - quote and paren aware declaration split. */
function importantify(css) {
  css = stripComments(css);
  const decls = [];
  let start = 0,
    depth = 0,
    quote = '';
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === "'" || c === '"') quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) {
      decls.push(css.slice(start, i));
      start = i + 1;
    }
  }
  decls.push(css.slice(start));
  return decls
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => (/!\s*important$/i.test(d) ? d : d + ' !important'))
    .join(';');
}

function pseudoClass(pseudo, css) {
  const k = pseudo + '|' + css;
  const hit = pseudoCache.get(k);
  if (hit) return hit;
  const cls = 'cmp' + pseudoCache.size.toString(36);
  const isElement = pseudo === 'before' || pseudo === 'after';
  const sel = isElement ? `.${cls}::${pseudo}` : `.${cls}:${pseudo}`;
  pseudoRules.push(`${sel}{${isElement ? css : importantify(css)}}`);
  pseudoCache.set(k, cls);
  return cls;
}

/* ─────────── attribute naming ─────────── */

const EVENT_MAP = {
  onclick: 'onClick', onchange: 'onChange', oninput: 'onInput', onsubmit: 'onSubmit',
  onkeydown: 'onKeyDown', onkeyup: 'onKeyUp', onkeypress: 'onKeyPress',
  onmousedown: 'onMouseDown', onmouseup: 'onMouseUp', onmouseenter: 'onMouseEnter',
  onmouseleave: 'onMouseLeave', onfocus: 'onFocus', onblur: 'onBlur', onerror: 'onError',
  ondoubleclick: 'onDoubleClick', oncontextmenu: 'onContextMenu', onmousemove: 'onMouseMove',
  onmouseover: 'onMouseOver', onmouseout: 'onMouseOut', onload: 'onLoad',
};

/** Lowercased by the HTML parser; React wants these spellings. Same DOM either way. */
const REACT_ATTR = {
  class: 'className', for: 'htmlFor', tabindex: 'tabIndex', crossorigin: 'crossOrigin',
  viewbox: 'viewBox', srcset: 'srcSet', maxlength: 'maxLength', autocomplete: 'autoComplete',
  readonly: 'readOnly', colspan: 'colSpan', rowspan: 'rowSpan', usemap: 'useMap',
  contenteditable: 'contentEditable', spellcheck: 'spellCheck', novalidate: 'noValidate',
  'stroke-width': 'strokeWidth', 'stroke-linecap': 'strokeLinecap',
  'stroke-linejoin': 'strokeLinejoin', 'fill-rule': 'fillRule', 'clip-rule': 'clipRule',
  'stop-color': 'stopColor', 'stop-opacity': 'stopOpacity',
};

/** Authoring-only attributes the runtime strips before rendering. */
const DROP = new Set(['hint-placeholder-count', 'hint-placeholder-val', 'hint-size', 'sc-name', 'data-dc-tpl']);

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr', 'path', 'circle', 'rect', 'line', 'polyline',
  'polygon', 'ellipse', 'stop', 'use']);

/* ─────────── expression scoping ─────────── */

const SIMPLE_PATH = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
const LITERAL = /^(true|false|null|undefined|-?\d+(\.\d+)?|'[^']*'|"[^"]*")$/;

/**
 * Everything reads from `v`, and every hop is optional.
 *
 * support.js's resolvePath walks with `cur == null ? undefined : cur[key]`, and
 * the design leans on that: `form.eName` is asked for before `renderVals` has
 * ever put an `errors` entry there, and must come back undefined rather than
 * throw. There are no loop variables in this design (no sc-for), so there is no
 * scope to carry.
 */
function expr(raw) {
  const e = raw.trim();
  if (LITERAL.test(e)) return e;
  if (!SIMPLE_PATH.test(e)) throw new Error(`unsupported expression: {{ ${e} }}`);
  return '$v?.' + e.split('.').join('?.');
}

const jsStr = (s) => JSON.stringify(s);

/* ─────────── emit ─────────── */

const INTERP = /\{\{([\s\S]+?)\}\}/;
const INTERP_G = /\{\{([\s\S]+?)\}\}/g;

/**
 * Assets that are SERVED in a different format from the one the design names.
 *
 * One entry, and it is worth the machinery. `team/founder-1.png` is a 24-bit
 * photograph stored as a PNG - a format for flat colour and line art. At the
 * size this page renders it (an avatar tile, roughly 400px) it was 908KB after
 * downscaling and 1.7MB before; as a JPEG it is a few tens of KB, and the page
 * preloads it, so those bytes are spent before anything is painted. On a page
 * whose entire audience arrives from a paid click on mobile data, that is not a
 * rounding error.
 *
 * Done here rather than by editing the design file, because the design file is
 * a copy of the design project's and an edit to it would be lost on the next
 * sync. Asserted below: if the design stops referencing this asset, the build
 * fails rather than quietly carrying a rule for a file nobody uses.
 */
const ASSET_FORMAT = {
  'assets/team/founder-1.png': 'assets/team/founder-1.jpg',
};
const assetFormatHits = Object.fromEntries(Object.keys(ASSET_FORMAT).map((k) => [k, 0]));

/**
 * The design lives at a single URL, so it references assets relatively. Served
 * at /<campaign>/, `assets/x.svg` would resolve to /<campaign>/assets/x.svg.
 * Root them instead: every campaign shares one public/assets tree.
 */
function rootAssets(raw) {
  let out = raw;
  for (const [from, to] of Object.entries(ASSET_FORMAT)) {
    if (out.includes(from)) {
      assetFormatHits[from] += out.split(from).length - 1;
      out = out.split(from).join(to);
    }
  }
  return out.replace(/(^|[\s(,'"])assets\//g, '$1/assets/');
}

/** support.js: compileAttr */
function attrValue(raw) {
  raw = rootAssets(raw);
  const whole = raw.match(/^\s*\{\{([\s\S]+?)\}\}\s*$/);
  if (whole) return `{${expr(whole[1])}}`;
  if (!raw.includes('{{')) return jsStr(raw);
  const parts = raw.split(INTERP_G);
  const body = parts
    .map((p, i) => (i & 1 ? '${$A(' + expr(p) + ')}' : p.replace(/[\\`$]/g, '\\$&')))
    .join('');
  return '{`' + body + '`}';
}

/** A style attribute always goes through st(); only its argument differs. */
function styleValue(raw) {
  raw = rootAssets(raw);
  if (!raw.includes('{{')) return `{$st(${jsStr(raw)})}`;
  const parts = raw.split(INTERP_G);
  const body = parts
    .map((p, i) => (i & 1 ? '${$A(' + expr(p) + ')}' : p.replace(/[\\`$]/g, '\\$&')))
    .join('');
  return '{$st(`' + body + '`)}';
}

const warnings = [];

function emitText(text) {
  // support.js: walkText - whitespace-only text with no space character is
  // dropped, everything else is preserved verbatim.
  if (!INTERP.test(text)) {
    if (!text.trim() && !text.includes(' ')) return '';
    return `{${jsStr(text)}}`;
  }
  return text
    .split(INTERP_G)
    .map((p, i) => {
      if (!(i & 1)) return p === '' ? '' : `{${jsStr(p)}}`;
      return `{$I(${expr(p)})}`;
    })
    .join('');
}

const emitChildren = (node, indent) =>
  (node.childNodes || []).map((c) => emitNode(c, indent)).filter(Boolean).join('\n');

function emitNode(node, indent) {
  const pad = '  '.repeat(indent);

  if (node.nodeName === '#text') {
    const out = emitText(node.value);
    return out ? pad + out : '';
  }
  if (node.nodeName === '#comment') return '';

  const tag = node.tagName;
  const attrs = Object.fromEntries((node.attrs || []).map((a) => [a.name, a.value]));

  if (tag === 'sc-for') {
    throw new Error(
      'sc-for found. This compiler deliberately does not implement it - see the ' +
        'header. Port the loop branch from landing/tools/dc2jsx.mjs if the design starts using it.',
    );
  }

  /* sc-if -> ternary */
  if (tag === 'sc-if') {
    const valRaw = (attrs.value || '').match(/^\s*\{\{([\s\S]+?)\}\}\s*$/);
    if (!valRaw) throw new Error(`sc-if without an interpolated value: ${attrs.value}`);
    const kids = emitChildren(node, indent + 1);
    return `${pad}{${expr(valRaw[1])} ? (\n${pad}  <>\n${kids}\n${pad}  </>\n${pad}) : null}`;
  }

  /* ordinary element */
  const props = [];
  const classes = [];
  for (const [name, value] of Object.entries(attrs)) {
    if (DROP.has(name)) continue;

    if (name === 'style') {
      props.push(`style=${styleValue(value)}`);
      continue;
    }

    if (name.startsWith('style-')) {
      const pseudo = name.slice(6);
      if (value.includes('{{')) {
        warnings.push(`dynamic ${name} not supported: ${value}`);
        continue;
      }
      classes.push(pseudoClass(pseudo, value));
      continue;
    }

    if (name === 'class') {
      classes.unshift(value);
      continue;
    }

    let key = name;
    if (name.startsWith('on')) key = EVENT_MAP[name] || 'on' + name[2].toUpperCase() + name.slice(3);
    else if (REACT_ATTR[name]) key = REACT_ATTR[name];

    props.push(`${key}=${attrValue(value)}`);
  }

  if (classes.length) props.unshift(`className=${jsStr(classes.join(' '))}`);

  const head = `<${tag}${props.length ? ' ' + props.join(' ') : ''}`;
  const kids = emitChildren(node, indent + 1);

  if (VOID.has(tag)) return `${pad}${head} />`;
  if (!kids.trim()) return `${pad}${head}></${tag}>`;
  return `${pad}${head}>\n${kids}\n${pad}</${tag}>`;
}

/* ─────────── run ─────────── */

const frag = parse5.parseFragment(template, { sourceCodeLocationInfo: false });

/**
 * The host element carries `id="dc-root"`, because dc-runtime gives it one when
 * it mounts (`hostEl.id = "dc-root"`). Cheap to add, and it is the difference
 * between the design's own script finding its root and silently doing nothing.
 */
const hostNode = frag.childNodes.find((n) => n.tagName === 'div');
if (!hostNode) throw new Error('no host element to mark as #dc-root');
if (!hostNode.attrs.some((a) => a.name === 'id')) {
  hostNode.attrs.unshift({ name: 'id', value: 'dc-root' });
}

const body = frag.childNodes.map((n) => emitNode(n, 2)).filter(Boolean).join('\n');

fs.mkdirSync(OUT_DIR, { recursive: true });

const tsx = `/* GENERATED by tools/dc2jsx.mjs from "GOTCHA Campaign Landing.dc.html".
   Do not edit: re-run \`npm run design:sync\` after changing the design. */
/* eslint-disable */
import React from 'react';
import { st as $st, I as $I, A as $A } from '@/lib/dc';

export default function Template({ v: $v }) {
  return (
    <>
${body}
    </>
  );
}
`;
fs.writeFileSync(path.join(OUT_DIR, 'Template.jsx'), tsx);

/* ─────────── the design's global CSS ─────────── */

const helmetCss = /<style>([\s\S]*?)<\/style>/.exec(helmet)?.[1];
if (!helmetCss) throw new Error('no <style> block in <helmet>');

/**
 * `[style*="…"]` selectors, in both spellings.
 *
 * The design targets a few elements by the literal text of their inline style,
 * and that text is not the same in both renderings: the design canvas sets each
 * property through CSSOM and the browser serialises it WITH a space after the
 * colon, while React's server renderer writes the attribute directly WITHOUT
 * one. A selector written for one matches nothing in the other.
 *
 * The marketing site has 202 lines of machinery for this because its phone
 * layout is built almost entirely out of such selectors. This design has
 * exactly one, and it is already written unspaced - so it matches the server
 * render today and would break the moment someone wrote the spaced form. Both
 * spellings are emitted so neither can be wrong, and the count is asserted so
 * that a design which starts leaning on this gets the real expander instead of
 * this shortcut.
 */
const styleSelectors = [...helmetCss.matchAll(/\[style\*="([^"]*)"\]/g)];
if (styleSelectors.length > 3) {
  throw new Error(
    `${styleSelectors.length} [style*=] selectors in the design. This compiler expands them ` +
      'naively; port expandStyleSelectors from landing/tools/ before going further.',
  );
}
let expanded = 0;

/** The other spelling of one attribute value, or null if it has no colon. */
const otherSpelling = (value) => {
  const other = value.includes(': ')
    ? value.replace(/:\s+/g, ':')
    : value.replace(/:(?=\S)/g, ': ');
  return other === value ? null : other;
};

/**
 * Expand the WHOLE SELECTOR, never just the attribute inside it.
 *
 * The first version of this rewrote the `[style*=…]` fragment in place, turning
 *
 *     [data-scene] [style*="font-size:14px"] { … }
 * into
 *     [data-scene] [style*="font-size:14px"],[style*="font-size: 14px"] { … }
 *
 * and the comma made the second half a selector in its own right - the
 * `[data-scene]` ancestor was silently dropped, so the rule escaped its section
 * and matched that inline style anywhere on the page. A duplicated selector has
 * to be duplicated whole.
 */
const designCss = helmetCss.trim().replace(
  // Every run of non-brace text immediately before a `{` is a selector (or an
  // at-rule prelude, which never contains `[style*=` and so falls straight
  // through). Anchoring on the PRECEDING brace instead missed any rule nested
  // inside a @media block, which is where all of them actually are.
  /([^{}]+)(\{)/g,
  (whole, selector, brace) => {
    if (!selector.includes('[style*=')) return whole;
    const parts = selector.split(',').map((p) => p.trim()).filter(Boolean);
    const out = [];
    for (const part of parts) {
      out.push(part);
      let variant = part;
      let changed = false;
      variant = variant.replace(/\[style\*="([^"]*)"\]/g, (frag, value) => {
        const other = otherSpelling(value);
        if (!other) return frag;
        changed = true;
        return `[style*="${other}"]`;
      });
      if (changed) {
        out.push(variant);
        expanded++;
      }
    }
    // Keep the selector's own leading whitespace so the sheet stays readable.
    const indent = /^\s*/.exec(selector)[0];
    return `${indent}${out.join(', ')}${brace}`;
  },
);

fs.writeFileSync(
  CSS_OUT,
  '/* GENERATED by tools/dc2jsx.mjs from the <helmet> block of the design file.\n' +
    '   Do not edit and do not reformat: rules here match on the literal text of\n' +
    '   inline style attributes. Re-run `npm run design:sync`. */\n' +
    designCss +
    '\n\n/* style-<pseudo> attributes, as real classes. */\n' +
    pseudoRules.join('\n') +
    '\n',
);

for (const [from, n] of Object.entries(assetFormatHits)) {
  if (n === 0) {
    throw new Error(
      `ASSET_FORMAT has an entry for "${from}" but the design no longer references it. ` +
        'Drop the entry, and the converted file with it.',
    );
  }
}

console.log('Template.jsx :', tsx.split('\n').length, 'lines');
console.log('re-encoded   :', Object.entries(assetFormatHits).map(([k, n]) => `${k.split('/').pop()} x${n}`).join(', ') || 'none');
console.log('campaign.css :', pseudoRules.length, 'pseudo rules +', designCss.split('\n').length, 'lines of design CSS');
console.log('[style*=]    :', styleSelectors.length, 'selectors,', expanded, 'expanded to both spellings');
if (warnings.length) {
  console.log('\nwarnings:');
  warnings.forEach((w) => console.log('  -', w));
}
