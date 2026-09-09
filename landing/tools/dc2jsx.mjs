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

const require = createRequire(path.join(ROOT, 'package.json'));
const parse5 = require('parse5');

const SRC = path.join(DESIGN, 'GOTCHA Landing.dc.html');
const OUT_DIR = path.join(ROOT, 'src/generated');

/* ─────────── source slicing ─────────── */

const src = fs.readFileSync(SRC, 'utf8');
const inner = src.slice(src.indexOf('<x-dc>') + 6, src.indexOf('</x-dc>'));
const helmet = inner.slice(inner.indexOf('<helmet>') + 8, inner.indexOf('</helmet>'));
const template = inner.slice(inner.indexOf('</helmet>') + 9);

/* ─────────── pseudo-class sheet (support.js: createPseudoSheet) ─────────── */

const pseudoRules = [];
const pseudoCache = new Map();

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** support.js: importantify - quote and paren aware declaration split. */
function importantify(css) {
  css = stripComments(css);
  const decls = [];
  let start = 0, depth = 0, quote = '';
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === "'" || c === '"') quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) { decls.push(css.slice(start, i)); start = i + 1; }
  }
  decls.push(css.slice(start));
  return decls.map((d) => d.trim()).filter(Boolean)
    .map((d) => (/!\s*important$/i.test(d) ? d : d + ' !important')).join(';');
}

function pseudoClass(pseudo, css) {
  const k = pseudo + '|' + css;
  const hit = pseudoCache.get(k);
  if (hit) return hit;
  const cls = 'scp' + pseudoCache.size.toString(36);
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
};

/** Authoring-only attributes the runtime strips before rendering. */
const DROP = new Set(['hint-placeholder-count', 'hint-placeholder-val', 'hint-size', 'sc-name', 'data-dc-tpl']);

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'stop', 'use']);

/* ─────────── expression scoping ─────────── */

const SIMPLE_PATH = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
const LITERAL = /^(true|false|null|undefined|-?\d+(\.\d+)?|'[^']*'|"[^"]*")$/;

/**
 * A path rooted in a loop variable stays bare; anything else reads from `v`.
 *
 * Every hop is optional. support.js's resolvePath walks with
 * `cur == null ? undefined : cur[key]`, and the design leans on it: on a
 * feature page `sol` is null and the template still asks for `sol.kicker`,
 * expecting undefined rather than a throw.
 */
function expr(raw, scope) {
  const e = raw.trim();
  if (LITERAL.test(e)) return e;
  if (!SIMPLE_PATH.test(e)) throw new Error(`unsupported expression: {{ ${e} }}`);
  const parts = e.split('.');
  if (scope.has(parts[0]) || parts[0] === '$index') return parts.join('?.');
  return '$v?.' + parts.join('?.');
}

const jsStr = (s) => JSON.stringify(s);

/* ─────────── emit ─────────── */

const INTERP = /\{\{([\s\S]+?)\}\}/;
const INTERP_G = /\{\{([\s\S]+?)\}\}/g;

/**
 * The design lives at a single URL, so it references assets relatively. Served
 * under real routes, `assets/x.png` on /product/copilot resolves to
 * /product/assets/x.png. Root them instead.
 */
function rootAssets(raw) {
  return raw.replace(/(^|[\s(,'"])assets\//g, '$1/assets/');
}

/** support.js: compileAttr */
function attrValue(raw, scope) {
  raw = rootAssets(raw);
  const whole = raw.match(/^\s*\{\{([\s\S]+?)\}\}\s*$/);
  if (whole) return `{${expr(whole[1], scope)}}`;
  if (!raw.includes('{{')) return jsStr(raw);
  const parts = raw.split(INTERP_G);
  const body = parts.map((p, i) => (i & 1 ? '${$A(' + expr(p, scope) + ')}' : p.replace(/[\\`$]/g, '\\$&'))).join('');
  return '{`' + body + '`}';
}

/** A style attribute always goes through st(); only its argument differs. */
function styleValue(raw, scope) {
  if (!raw.includes('{{')) return `{$st(${jsStr(raw)})}`;
  const parts = raw.split(INTERP_G);
  const body = parts.map((p, i) => (i & 1 ? '${$A(' + expr(p, scope) + ')}' : p.replace(/[\\`$]/g, '\\$&'))).join('');
  return '{$st(`' + body + '`)}';
}

let warnings = [];

function emitText(text, scope) {
  // support.js: walkText - whitespace-only text with no space character is dropped,
  // everything else is preserved verbatim.
  if (!INTERP.test(text)) {
    if (!text.trim() && !text.includes(' ')) return '';
    return `{${jsStr(text)}}`;
  }
  const parts = text.split(INTERP_G);
  return parts.map((p, i) => {
    if (!(i & 1)) return p === '' ? '' : `{${jsStr(p)}}`;
    return `{$I(${expr(p, scope)})}`;
  }).join('');
}

function emitChildren(node, scope, indent) {
  return (node.childNodes || []).map((c) => emitNode(c, scope, indent)).filter(Boolean).join('\n');
}

function emitNode(node, scope, indent) {
  const pad = '  '.repeat(indent);

  if (node.nodeName === '#text') {
    const out = emitText(node.value, scope);
    return out ? pad + out : '';
  }
  if (node.nodeName === '#comment') return '';

  const tag = node.tagName;
  const attrs = Object.fromEntries((node.attrs || []).map((a) => [a.name, a.value]));

  /* sc-for -> .map() */
  if (tag === 'sc-for') {
    const as = attrs.as || 'item';
    const listRaw = (attrs.list || '').match(/^\s*\{\{([\s\S]+?)\}\}\s*$/);
    if (!listRaw) throw new Error(`sc-for without an interpolated list: ${attrs.list}`);
    const inner = new Set([...scope, as]);
    const kids = emitChildren(node, inner, indent + 2);
    return `${pad}{$L(${expr(listRaw[1], scope)}).map((${as}, $index) => (\n` +
           `${pad}  <React.Fragment key={$index}>\n${kids}\n${pad}  </React.Fragment>\n` +
           `${pad}))}`;
  }

  /* sc-if -> ternary */
  if (tag === 'sc-if') {
    const valRaw = (attrs.value || '').match(/^\s*\{\{([\s\S]+?)\}\}\s*$/);
    if (!valRaw) throw new Error(`sc-if without an interpolated value: ${attrs.value}`);
    const kids = emitChildren(node, scope, indent + 1);
    return `${pad}{${expr(valRaw[1], scope)} ? (\n${pad}  <>\n${kids}\n${pad}  </>\n${pad}) : null}`;
  }

  /* image-slot -> the resolved photo, cropped the way the slot was framed */
  if (tag === 'image-slot') {
    const id = attrs.id || '';
    const style = attrs.style || '';
    return `${pad}<ImageSlot id=${jsStr(id)} style=${styleValue(style, scope)} />`;
  }

  /* ordinary element */
  const props = [];
  const classes = [];
  for (const [name, value] of Object.entries(attrs)) {
    if (DROP.has(name)) continue;

    if (name === 'style') { props.push(`style=${styleValue(value, scope)}`); continue; }

    if (name.startsWith('style-')) {
      const pseudo = name.slice(6);
      if (value.includes('{{')) { warnings.push(`dynamic ${name} not supported: ${value}`); continue; }
      classes.push(pseudoClass(pseudo, value));
      continue;
    }

    if (name === 'class') { classes.unshift(value); continue; }

    let key = name;
    if (name.startsWith('on')) key = EVENT_MAP[name] || 'on' + name[2].toUpperCase() + name.slice(3);
    else if (REACT_ATTR[name]) key = REACT_ATTR[name];

    props.push(`${key}=${attrValue(value, scope)}`);
  }

  if (classes.length) {
    const lit = classes.filter((c) => !c.includes('{'));
    props.unshift(`className=${jsStr(lit.join(' '))}`);
  }

  const head = `<${tag}${props.length ? ' ' + props.join(' ') : ''}`;
  const kids = emitChildren(node, scope, indent + 1);

  if (VOID.has(tag) || !kids.trim()) {
    // An <i data-lucide> stays a real empty element: paintIcons() injects the svg
    // into it and React must keep believing it owns no children there.
    if (VOID.has(tag)) return `${pad}${head} />`;
    return `${pad}${head}></${tag}>`;
  }
  return `${pad}${head}>\n${kids}\n${pad}</${tag}>`;
}

/* ─────────── run ─────────── */

const frag = parse5.parseFragment(template, { sourceCodeLocationInfo: false });
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

let linked = body;
for (const [label, href] of Object.entries(LEGAL_LINKS)) {
  const pattern = new RegExp(
    '(<a[^>]*?)href="#top"([^>]*>\\s*\\n\\s*\\{"' + label + '"\\})',
  );
  if (!pattern.test(linked)) {
    throw new Error(
      `footer legal link "${label}" not found as an href="#top" placeholder. ` +
        'The design changed; update LEGAL_LINKS in tools/dc2jsx.mjs.',
    );
  }
  linked = linked.replace(pattern, `$1href="${href}"$2`);
}

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

/* The <helmet> <style> block is the design's global CSS: resets, keyframes and
   the RTL overrides. Several of those rules match on the literal text of an
   inline style attribute, so it goes out verbatim - never reformatted. It is
   generated rather than copied because the design edits it, and a stale copy
   fails silently: the page still renders, just with last week's rules. */
const helmetCss = /<style>([\s\S]*?)<\/style>/.exec(helmet)?.[1];
if (!helmetCss) throw new Error('no <style> block in <helmet>');

fs.writeFileSync(path.join(ROOT, 'src/app/globals.css'),
  '/* GENERATED by tools/dc2jsx.mjs from the <helmet> block of the design file.\n' +
  '   Do not edit and do not reformat: rules here match on the literal text of\n' +
  '   inline style attributes. Re-run `npm run design:sync`. */\n' +
  helmetCss.trim() + '\n\n' +
  '/* style-<pseudo> attributes, as real classes. */\n' +
  pseudoRules.join('\n') + '\n');

console.log('Template.jsx :', tsx.split('\n').length, 'lines');
console.log('globals.css  :', pseudoRules.length, 'pseudo rules +', helmetCss.trim().split(String.fromCharCode(10)).length, 'lines of design CSS');
if (warnings.length) {
  console.log('\nwarnings:');
  warnings.forEach((w) => console.log('  -', w));
}
