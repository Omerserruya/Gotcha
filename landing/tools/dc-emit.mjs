/**
 * The template emitter, shared by every compiled design: dc-runtime's template
 * semantics (sc-for, sc-if, interpolation, style, style-<pseudo>) as JSX text.
 *
 * Lifted out of dc2jsx.mjs unchanged so a second design compiles through the
 * same rules instead of a copy of them that could drift. Each call returns a
 * fresh emitter: the pseudo-class sheet and the warnings belong to one run.
 */
export function createEmitter({ assetBase = '/assets/', reactAttrs = {}, rootStyleAssets = false, runtimePseudo = false } = {}) {
  const pseudoRules = [];
  const pseudoCache = new Map();
  let warnings = [];

  /* ─────────── pseudo-class sheet (support.js: createPseudoSheet) ─────────── */


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
    // support.js grew these after the first port. Without them the fallback
    // spells `onpointerdown` as `onPointerdown`, which React drops - the v8
    // home's before/after slider would not drag.
    onpointerdown: 'onPointerDown', onpointerup: 'onPointerUp', onpointermove: 'onPointerMove',
    onpointerenter: 'onPointerEnter', onpointerleave: 'onPointerLeave', onpointercancel: 'onPointerCancel',
    onpointerover: 'onPointerOver', onpointerout: 'onPointerOut',
    ongotpointercapture: 'onGotPointerCapture', onlostpointercapture: 'onLostPointerCapture',
    ontouchstart: 'onTouchStart', ontouchend: 'onTouchEnd', ontouchmove: 'onTouchMove', ontouchcancel: 'onTouchCancel',
    ondragstart: 'onDragStart', ondragend: 'onDragEnd', ondragenter: 'onDragEnter', ondragleave: 'onDragLeave',
    ondragover: 'onDragOver', onanimationstart: 'onAnimationStart', onanimationend: 'onAnimationEnd',
    onanimationiteration: 'onAnimationIteration', ontransitionend: 'onTransitionEnd',
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
    return raw.replace(/(^|[\s(,'"])assets\//g, '$1' + assetBase);
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
    // Off for the older design, whose output must not move; the v8 home sets
    // `url(assets/…)` inside inline styles and needs it rooted like any src.
    if (rootStyleAssets) raw = raw.replace(/url\(assets\//g, 'url(' + assetBase);
    if (!raw.includes('{{')) return `{$st(${jsStr(raw)})}`;
    const parts = raw.split(INTERP_G);
    const body = parts.map((p, i) => (i & 1 ? '${$A(' + expr(p, scope) + ')}' : p.replace(/[\\`$]/g, '\\$&'))).join('');
    return '{$st(`' + body + '`)}';
  }


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
    for (let [name, value] of Object.entries(attrs)) {
      if (DROP.has(name)) continue;

      if (name === 'style') { props.push(`style=${styleValue(value, scope)}`); continue; }

      if (name.startsWith('style-')) {
        const pseudo = name.slice(6);
        if (value.includes('{{')) {
          // support.js does not interpolate here: it writes the rule with the
          // binding in it, and the browser drops that one declaration and keeps
          // the rest. `runtimePseudo` reproduces that; otherwise skip and warn.
          if (!runtimePseudo) { warnings.push(`dynamic ${name} not supported: ${value}`); continue; }
          // The bundler's CSS parser rejects the binding outright, so drop that
          // declaration here, as the browser would, and keep the others.
          value = value.split(';').filter((d) => d.trim() && !d.includes('{{')).join(';');
          if (!value) continue;
        }
        classes.push(pseudoClass(pseudo, value));
        continue;
      }

      if (name === 'class') { classes.unshift(value); continue; }

      let key = name;
      if (name.startsWith('on')) key = EVENT_MAP[name] || 'on' + name[2].toUpperCase() + name.slice(3);
      else if (reactAttrs[name] || REACT_ATTR[name]) key = reactAttrs[name] || REACT_ATTR[name];

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

  return { emitNode, emitChildren, pseudoRules, warnings, jsStr };
}
