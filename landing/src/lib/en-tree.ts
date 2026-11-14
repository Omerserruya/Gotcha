/**
 * The v8 design's `enPass()`, applied to the rendered element tree.
 *
 * The design's template is written in Hebrew. For English it renders that
 * Hebrew and then walks the DOM under `[data-site="main"]`, after every update:
 *
 *   - a text node with Hebrew in it is replaced by `toEn()` of it, unless its
 *     parent carries data-chw / data-lw / data-hw (the split-word animations,
 *     whose words come from the data already in English);
 *   - every `dir="rtl"` becomes `ltr`, and the root gets dir=ltr lang=en;
 *   - every `←` in a text node becomes `→`;
 *   - placeholder, aria-label, alt and title with Hebrew go through `toEn()`.
 *
 * Doing the same to the tree puts the English into the server-rendered page, so
 * an English reader never sees the Hebrew first. The design's own enPass() still
 * runs after mount; on this output it finds nothing left to change.
 */
import React from 'react';

const HEB = /[֐-׿]/;
const KEEP_TEXT = ['data-chw', 'data-lw', 'data-hw'];
const ATTRS = ['placeholder', 'aria-label', 'alt', 'title'];

type ToEn = (s: string) => string;

function text(v: string, keep: boolean, toEn: ToEn): string {
  let out = v;
  if (!keep && HEB.test(out)) out = toEn(out);
  if (out.indexOf('←') >= 0) out = out.split('←').join('→');
  return out;
}

function walk(node: React.ReactNode, inMain: boolean, keep: boolean, toEn: ToEn): React.ReactNode {
  if (typeof node === 'string') return inMain ? text(node, keep, toEn) : node;
  if (Array.isArray(node)) {
    const out = node.map((c) => walk(c, inMain, keep, toEn));
    return out.some((c, i) => c !== node[i]) ? out : node;
  }
  if (!React.isValidElement(node)) return node;

  const props = node.props as Record<string, any>;
  const isRoot = props['data-site'] === 'main';
  const main = inMain || isRoot;
  const changes: Record<string, unknown> = {};

  if (main) {
    if (isRoot) {
      changes.dir = 'ltr';
      changes.lang = 'en';
    } else if (props.dir === 'rtl') {
      changes.dir = 'ltr';
    }
    for (const a of ATTRS) {
      const v = props[a];
      if (typeof v === 'string' && HEB.test(v)) {
        const r = toEn(v);
        if (r !== v) changes[a] = r;
      }
    }
  }

  let kids: React.ReactNode = props.children;
  if (props.children !== undefined) {
    const keepChildren = KEEP_TEXT.some((a) => props[a] !== undefined);
    kids = walk(props.children, main, keepChildren, toEn);
  }

  if (!Object.keys(changes).length && kids === props.children) return node;
  // Children go back as arguments, the way JSX passed them: handed over as one
  // array prop they would read as a list and need keys they never had.
  return Array.isArray(kids)
    ? React.cloneElement(node, changes, ...kids)
    : React.cloneElement(node, { ...changes, children: kids });
}

export function enTree(tree: React.ReactNode, toEn: ToEn): React.ReactNode {
  return walk(tree, false, false, toEn);
}
