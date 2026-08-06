import React from "react";

/**
 * Render WhatsApp's own text formatting, the way the sender wrote it.
 *
 * WhatsApp messages carry markup - `*bold*`, `_italic_`, `~strike~`,
 * ```monospace``` - and senders (including Meta's own onboarding nudges) rely on
 * it. The inbox printed the raw characters, so a customer saw
 * "*Continue setting up your account*" with the asterisks, and a link to
 * business.facebook.com as dead text they had to copy by hand.
 *
 * Everything is built as React nodes. No dangerouslySetInnerHTML anywhere near
 * this: message bodies are attacker-controlled by definition - anyone who can
 * message the business can put anything in them - so the text never becomes
 * markup, it becomes children.
 */

/** http/https only. A `javascript:` URL must never become a clickable link. */
const URL_RE = /\bhttps?:\/\/[^\s<>()[\]{}"']+/gi;

type Span = { text: string; bold?: boolean; italic?: boolean; strike?: boolean; mono?: boolean };

/**
 * WhatsApp's rule, simplified to the part that matters: a marker pairs with the
 * next identical marker, and the run between them must not be empty. An
 * unmatched marker is literal - "2 * 3 = 6" is arithmetic, not italics.
 */
function parseSpans(text: string): Span[] {
  const out: Span[] = [];
  let buf = "";
  let i = 0;
  const active = { bold: false, italic: false, strike: false, mono: false };

  const flush = () => {
    if (buf) out.push({ text: buf, ...active });
    buf = "";
  };

  while (i < text.length) {
    // ```mono``` first: its delimiter contains no other marker character.
    if (text.startsWith("```", i)) {
      const end = text.indexOf("```", i + 3);
      if (end > i + 3) {
        flush();
        out.push({ text: text.slice(i + 3, end), mono: true });
        i = end + 3;
        continue;
      }
    }

    const ch = text[i];
    const kind =
      ch === "*" ? "bold" : ch === "_" ? "italic" : ch === "~" ? "strike" : ch === "`" ? "mono" : null;

    if (kind) {
      if (active[kind]) {
        // Closing marker.
        flush();
        active[kind] = false;
        i += 1;
        continue;
      }
      // Opening only if a matching marker follows with something between them.
      const close = text.indexOf(ch, i + 1);
      if (close > i + 1) {
        flush();
        active[kind] = true;
        i += 1;
        continue;
      }
    }

    buf += ch;
    i += 1;
  }
  flush();
  return out;
}

/** Split one span's text into plain runs and links. */
function linkify(span: Span, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let n = 0;
  // exec in a loop rather than matchAll: this tsconfig targets ES5, where
  // iterating a matchAll result needs downlevelIteration.
  const re = new RegExp(URL_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(span.text)) !== null) {
    const start = m.index;
    if (start > last) nodes.push(span.text.slice(last, start));
    const href = m[0];
    nodes.push(
      <a
        key={`${keyPrefix}-l${n++}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="underline break-all hover:opacity-80"
      >
        {href}
      </a>,
    );
    last = start + href.length;
  }
  if (last < span.text.length) nodes.push(span.text.slice(last));
  return nodes;
}

function wrap(span: Span, children: React.ReactNode, key: string): React.ReactNode {
  if (span.mono) {
    return (
      <code key={key} className="px-1 py-0.5 rounded bg-black/10 font-mono text-[0.92em]">
        {children}
      </code>
    );
  }
  let node: React.ReactNode = children;
  if (span.strike) node = <s key={`${key}-s`}>{node}</s>;
  if (span.italic) node = <em key={`${key}-i`}>{node}</em>;
  if (span.bold) node = <strong key={`${key}-b`}>{node}</strong>;
  return <React.Fragment key={key}>{node}</React.Fragment>;
}

/**
 * Message text as React nodes: WhatsApp formatting applied, URLs clickable,
 * everything else left exactly as the sender typed it.
 */
export function renderMessageText(text: string): React.ReactNode[] {
  if (!text) return [];
  return parseSpans(text).map((span, i) => wrap(span, linkify(span, `s${i}`), `s${i}`));
}
