/**
 * The lead form's two states, taken from the v8 design's contact-page form.
 *
 * Neither the v8 home's bottom form nor the older design's lead cards were
 * drawn with a sent state or an error line; the v8 contact form has both. Omer's
 * decision is that every lead form sends, so both compilers graft these two
 * nodes, copied node for node and rebound from `tk.*` to the form's own
 * bindings - one source for every form on the site, never a redrawn copy.
 *
 *   err   <sc-if {{ tk.err }}><div role="alert">{{ tk.errText }}</div></sc-if>
 *   sent  <sc-if {{ tk.sent }}><div data-tk-ok role="status">check, title, body, "Pick a time"</div></sc-if>
 */
import fs from 'node:fs';
import path from 'node:path';

const attr = (n, name) => (n.attrs || []).find((a) => a.name === name)?.value;
const flagOf = (n) => /^\s*\{\{\s*([\s\S]+?)\s*\}\}\s*$/.exec(attr(n, 'value') ?? '')?.[1];

export function walk(node, visit) {
  visit(node);
  for (const child of [...(node.childNodes ?? [])]) walk(child, visit);
}

export function findAll(root, pred) {
  const out = [];
  walk(root, (n) => { if (pred(n)) out.push(n); });
  return out;
}

/** A deep copy with every `{{ tk.` binding rewritten to `{{ <prefix>.`. */
export function cloneRebind(n, parent, prefix) {
  const re = /\{\{\s*tk\./g;
  const c = { ...n, parentNode: parent };
  if (n.attrs) c.attrs = n.attrs.map((a) => ({ ...a, value: a.value.replace(re, `{{ ${prefix}.`) }));
  if (n.childNodes) c.childNodes = n.childNodes.map((k) => cloneRebind(k, c, prefix));
  if (n.nodeName === '#text') c.value = n.value.replace(re, `{{ ${prefix}.`);
  return c;
}

export const el = (tagName, attrs, parent) => ({
  nodeName: tagName, tagName, attrs, namespaceURI: 'http://www.w3.org/1999/xhtml', childNodes: [], parentNode: parent,
});

/** The two state nodes, found inside the v8 template's talk (contact) page branch. */
export function talkStates(parse5, v8File) {
  const src = fs.readFileSync(v8File, 'utf8');
  const inner = src.slice(src.indexOf('<x-dc>') + 6, src.indexOf('</x-dc>'));
  const template = inner.slice(inner.indexOf('</helmet>') + 9);
  const frag = parse5.parseFragment(template, { sourceCodeLocationInfo: false });
  const talk = findAll(frag, (n) => n.tagName === 'sc-if' && flagOf(n) === 'isTalk');
  if (talk.length !== 1) throw new Error(`lead-graft: expected one isTalk branch in ${path.basename(v8File)}, found ${talk.length}`);
  const err = findAll(talk[0], (n) => n.tagName === 'sc-if' && flagOf(n) === 'tk.err');
  const sent = findAll(talk[0], (n) => n.tagName === 'sc-if' && flagOf(n) === 'tk.sent');
  if (err.length !== 1 || sent.length !== 1) throw new Error(`lead-graft: talk form states moved (err ${err.length}, sent ${sent.length})`);
  return { err: err[0], sent: sent[0] };
}
