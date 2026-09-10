/**
 * Makes the design's `[style*="…"]` rules match a server-rendered page.
 *
 * The design targets elements by the literal text of their inline style -
 * `[style*="font-size: 76px"]`, `[style*="max-width: 1240px"]` - which is how
 * its whole phone layout and its RTL overrides are written. That text is not
 * the same in both renderings:
 *
 *   the design (client-rendered)  React sets each property through CSSOM and
 *                                 the browser serialises it: "font-size: 76px"
 *   this port (server-rendered)   React writes the attribute directly, with no
 *                                 space after the colon: "font-size:76px"
 *
 * So most of the design's selectors match nothing here, and the phone layout it
 * ships would silently do nothing. Each selector is emitted in both spellings
 * instead.
 *
 * The stylesheet is tokenised rather than pattern-matched, after three separate
 * bugs from doing this with a regular expression - the last one fatal. The
 * design writes `[style*="padding: 44px;"]`, and a `;` inside a quoted
 * attribute value looks exactly like the end of a declaration: splitting there
 * cut the selector in half, and the browser then dropped 48 of the 58 rules in
 * the phone block. The page still rendered, just with almost none of its mobile
 * layout, which is the kind of failure that reaches production.
 */

const ATTR = /\[style\*="([^"]*)"\]/g;
const MAX_TERMS = 4;

/**
 * `flex: <grow>` and its longhand serialisation `<grow> 1 0%` are the same
 * declaration, so a rule written on one has to find the other.
 *
 * It cannot be matched with `*=` alone. `[style*="flex:1"]` is a substring
 * test, and it also hits `flex:1 1 420px` and `flex:1.35`, which the design's
 * rule does not touch - the runtime spells those out in full, so its own
 * selector never sees them. The declaration therefore has to be anchored: `;`
 * when something follows it, and a `$=` suffix match when it is last, which on
 * the home page is 34 of the 54 occurrences.
 */
function flexShorthand(value) {
  const m = /^\s*flex:\s*([\d.]+)\s+1\s+0(px|%)?\s*$/i.exec(value);
  if (!m) return [];
  const decl = `flex: ${m[1]}`;
  return [
    { op: '*', v: `${decl};` },
    { op: '*', v: `${decl.replace(': ', ':')};` },
    { op: '$', v: decl },
    { op: '$', v: decl.replace(': ', ':') },
  ];
}

/**
 * Every way the same declaration can be written in a style attribute.
 *
 * Two normalisations separate the design's rendering from this one, and the
 * design's selectors are written against the first:
 *
 *   colon spacing   CSSOM writes "font-size: 76px"; React's server renderer
 *                   writes "font-size:76px"
 *   bare zero       CSSOM expands "margin:0 auto" into "margin: 0px auto"; the
 *                   server renderer leaves the 0 alone
 *
 * The second is why the section rhythm rules - all keyed on paddings such as
 * "padding: 98px 0px" - were silently missing, leaving the phone layout about
 * 1,300px taller than the design's.
 *
 * A third difference is a shorthand rather than a spelling; see flexShorthand.
 */

function spellings(value) {
  const colon = [...new Set([value.replace(/:\s*/g, ': '), value.replace(/:\s*/g, ':')])];
  const out = new Set();
  for (const v of colon) {
    out.add(v);
    // Standalone lengths only: never a bare 0 that is a unitless number, such
    // as a z-index or a line-height.
    if (/(?<![\w.#-])0px(?![\w-])/.test(v)) out.add(v.replace(/(?<![\w.#-])0px(?![\w-])/g, '0'));
    if (/(?<![\w.#-])0(?![\w.%-])/.test(v)) out.add(v.replace(/(?<![\w.#-])0(?![\w.%-])/g, '0px'));
  }
  return [...[...out].map((v) => ({ op: '*', v })), ...flexShorthand(value)];
}

/** One comma-free selector, in every spelling combination its terms allow. */
function expandOne(selector) {
  const terms = [...selector.matchAll(ATTR)];
  if (terms.length === 0 || terms.length > MAX_TERMS) return [selector];

  let out = [''];
  let last = 0;
  for (const m of terms) {
    const before = selector.slice(last, m.index);
    const options = spellings(m[1]);
    out = out.flatMap((prefix) => options.map(({ op, v }) => `${prefix}${before}[style${op}="${v}"]`));
    last = m.index + m[0].length;
  }
  const tail = selector.slice(last);
  return [...new Set(out.map((s) => s + tail))];
}

/** Split a selector list on commas that are not inside quotes or brackets. */
function splitSelectorList(text) {
  const parts = [];
  let buf = '';
  let quote = '';
  let depth = 0;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      buf += c;
      if (c === '\\') buf += text[++i] ?? '';
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; buf += c; continue; }
    if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    if (c === ',' && depth === 0) { parts.push(buf); buf = ''; continue; }
    buf += c;
  }
  parts.push(buf);
  return parts.map((s) => s.trim()).filter(Boolean);
}

/**
 * Rewrite every rule's selector. Declarations, at-rule preludes and comments
 * pass through untouched.
 */
export function expandStyleSelectors(css) {
  let expanded = 0;
  let out = '';
  let prelude = '';
  let depth = 0;
  let quote = '';
  let i = 0;

  const flushPrelude = () => {
    const text = prelude;
    prelude = '';
    if (!text.includes('[style*=')) return text;

    // A comment sitting between the previous rule and this one is part of the
    // captured text; peel it off so it is not repeated on every variant.
    const lead = /^([\s\S]*\*\/\s*|\s*)/.exec(text)[0];
    const selector = text.slice(lead.length);

    const grown = splitSelectorList(selector).flatMap((part) => {
      const variants = expandOne(part);
      if (variants.length > 1) expanded++;
      return variants;
    });
    return `${lead}${grown.join(',\n')}`;
  };

  while (i < css.length) {
    const c = css[i];

    if (quote) {
      prelude += c;
      if (c === '\\') prelude += css[++i] ?? '';
      else if (c === quote) quote = '';
      i++;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; prelude += c; i++; continue; }

    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      const stop = end === -1 ? css.length : end + 2;
      prelude += css.slice(i, stop);
      i = stop;
      continue;
    }

    if (c === '{') {
      out += flushPrelude() + '{';
      depth++;
      i++;
      continue;
    }
    if (c === '}') {
      out += prelude + '}';
      prelude = '';
      depth--;
      i++;
      continue;
    }
    if (c === ';' && depth > 0) {
      // Inside a block this really is a declaration separator.
      out += prelude + ';';
      prelude = '';
      i++;
      continue;
    }

    prelude += c;
    i++;
  }

  return { css: out + prelude, expanded };
}
