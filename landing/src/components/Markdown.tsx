import React from 'react';
import { C, F } from '@/lib/site';

/**
 * A renderer for exactly the markdown the legal documents use.
 *
 * The documents were surveyed rather than guessed at: across all six, in both
 * languages, they use h2, h3, unordered lists, blockquotes, bold, inline code,
 * links and tables. Nothing else. A general markdown library would be a new
 * dependency for a known, closed set of constructs - and tables are a GitHub
 * extension most renderers need a second plugin for anyway, which is why the
 * build tool already parses them out into their own blocks.
 *
 * Anything outside that set renders as its own literal text rather than
 * disappearing, so an unsupported construct shows up as something to fix
 * instead of silently dropping a clause from a contract.
 */

type Block = { kind: 'markdown'; text: string } | { kind: 'table'; head: string[]; rows: string[][] };

/**
 * Stable id for a section heading, so the contents list can link into a long
 * document. Unicode-aware: the Hebrew documents have Hebrew headings, and a
 * [^a-z0-9] slug would reduce every one of them to the same empty string.
 */
export const anchorFor = (heading: string) =>
  'sec-' + heading.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');

/** Bold, italic, inline code and links, one pass so nesting order is predictable. */
function inline(text: string, keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  // Bold before italic: `**x**` would otherwise match the italic branch twice.
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|\*([^*\n]+)\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;

  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyPrefix}-${i++}`;
    if (m[1] !== undefined) {
      out.push(<strong key={key} style={{ fontWeight: 600, color: C.ink }}>{m[1]}</strong>);
    } else if (m[2] !== undefined) {
      out.push(
        <code
          key={key}
          style={{ font: `400 .92em ${F.mono}`, background: C.sand, borderRadius: 5, padding: '2px 5px' }}
        >
          {m[2]}
        </code>,
      );
    } else if (m[3] !== undefined) {
      out.push(
        <a key={key} href={m[4]} style={{ color: C.accent, textDecoration: 'underline' }}>
          {m[3]}
        </a>,
      );
    } else {
      out.push(<em key={key} style={{ fontStyle: 'italic' }}>{m[5]}</em>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Prose({ text }: { text: string }) {
  const nodes: React.ReactNode[] = [];
  const lines = text.split('\n');
  let list: string[] = [];
  let quote: string[] = [];
  let para: string[] = [];
  let k = 0;

  const flushList = () => {
    if (!list.length) return;
    nodes.push(
      <ul key={`u${k++}`} style={{ margin: '0 0 18px', paddingInlineStart: 22, display: 'grid', gap: 8 }}>
        {list.map((li, j) => (
          <li key={j} style={{ fontSize: 15.5, lineHeight: 1.75, color: C.body }}>
            {inline(li, `l${k}-${j}`)}
          </li>
        ))}
      </ul>,
    );
    list = [];
  };
  const flushQuote = () => {
    if (!quote.length) return;
    nodes.push(
      <blockquote
        key={`q${k++}`}
        style={{
          margin: '0 0 20px',
          padding: '14px 18px',
          background: C.accentWash,
          borderInlineStart: `3px solid ${C.accent}`,
          borderRadius: '0 12px 12px 0',
          fontSize: 15,
          lineHeight: 1.7,
          color: C.body,
        }}
      >
        {inline(quote.join(' '), `q${k}`)}
      </blockquote>,
    );
    quote = [];
  };
  const flushPara = () => {
    if (!para.length) return;
    nodes.push(
      <p key={`p${k++}`} style={{ margin: '0 0 18px', fontSize: 15.5, lineHeight: 1.8, color: C.body }}>
        {inline(para.join(' '), `p${k}`)}
      </p>,
    );
    para = [];
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (!line.trim()) {
      flushAll();
      continue;
    }
    const h = line.match(/^(#{2,3})\s+(.*)$/);
    if (h) {
      flushAll();
      const level = h[1].length;
      nodes.push(
        React.createElement(
          level === 2 ? 'h2' : 'h3',
          {
            key: `h${k++}`,
            // Only h2 gets an id: the contents list is built from h2 alone, and
            // an unreferenced id on every h3 is just noise in the markup.
            id: level === 2 ? anchorFor(h[2]) : undefined,
            style:
              level === 2
                ? { margin: '38px 0 14px', fontSize: 23, lineHeight: 1.25, letterSpacing: '-0.02em', color: C.ink, scrollMarginTop: 96 }
                : { margin: '26px 0 10px', fontSize: 17, lineHeight: 1.35, color: C.ink },
          },
          inline(h[2], `h${k}`),
        ),
      );
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      flushPara();
      flushQuote();
      list.push(line.replace(/^[-*]\s+/, ''));
      continue;
    }
    if (line.startsWith('> ')) {
      flushPara();
      flushList();
      quote.push(line.slice(2));
      continue;
    }
    flushList();
    flushQuote();
    para.push(line);
  }
  flushAll();

  return <>{nodes}</>;
}

function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div style={{ margin: '0 0 26px', overflowX: 'auto', border: `1px solid ${C.line}`, borderRadius: 14 }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 520, background: C.card }}>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th
                key={i}
                style={{
                  textAlign: 'start',
                  font: `500 11px ${F.mono}`,
                  letterSpacing: '.1em',
                  textTransform: 'uppercase',
                  color: C.muted,
                  padding: '12px 16px',
                  borderBottom: `1px solid ${C.line}`,
                  whiteSpace: 'nowrap',
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((cell, j) => (
                <td
                  key={j}
                  style={{
                    fontSize: 14.5,
                    lineHeight: 1.65,
                    color: C.body,
                    padding: '13px 16px',
                    borderTop: i ? `1px solid ${C.line}` : undefined,
                    verticalAlign: 'top',
                  }}
                >
                  {inline(cell, `t${i}-${j}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Raw markdown, for the help articles.
 *
 * The legal documents arrive pre-split into prose and table blocks by the build
 * tool; the help articles are plain markdown strings written inline, so they go
 * through the same renderer as a single prose block.
 */
export function MarkdownText({ text }: { text: string }) {
  return <Prose text={text} />;
}

export default function Markdown({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, i) =>
        b.kind === 'table' ? (
          <Table key={i} head={b.head} rows={b.rows} />
        ) : (
          <Prose key={i} text={b.text} />
        ),
      )}
    </>
  );
}
