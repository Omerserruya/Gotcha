import type { ReactNode } from 'react';

import { MarkdownInline } from '@/features/home/AnswerText';

import styles from './DocumentDrawer.module.css';

/**
 * A knowledge document's text in basic markdown (supervisor, measured on dev:
 * the drawer showed "## מי אנחנו" and "- שם: …" as written). Headings,
 * bullet and numbered lists, paragraphs; inside them the answer's own inline
 * marks - bold, italics, code, and a link only when it is `http(s)://` or an
 * in-app path (`MarkdownInline`). It builds elements and never parses HTML,
 * so a `<script>` in a document is text.
 *
 * A heading is one level under the drawer's section title (h3): `#` is h4,
 * `##` h5, and every deeper one h6.
 *
 * ★ Each heading, paragraph and LIST ITEM reads in its own direction
 *   (`dir="auto"`; supervisor at 1440: "שם: Urban Supply - GOTCHA Demo" drew
 *   as "Urban Supply - GOTCHA Demo :שם" under a list that took one direction
 *   for all its items). A Hebrew item's bullet sits on its right.
 */
export function DocumentText({ text }: { readonly text: string }) {
  return <>{blocks(text).map(renderBlock)}</>;
}

type Block =
  | { readonly kind: 'h'; readonly level: 4 | 5 | 6; readonly text: string }
  | { readonly kind: 'p'; readonly lines: readonly string[] }
  | { readonly kind: 'ul' | 'ol'; readonly items: readonly string[] };

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

export function blocks(text: string): Block[] {
  const out: Block[] = [];
  for (const line of text.split(/\r?\n/)) {
    const heading = HEADING.exec(line);
    const bullet = heading ? null : BULLET.exec(line);
    const numbered = heading || bullet ? null : NUMBERED.exec(line);
    const last = out.at(-1);
    if (heading) {
      const level = Math.min(heading[1]!.length + 3, 6) as 4 | 5 | 6;
      out.push({ kind: 'h', level, text: heading[2]! });
    } else if (bullet || numbered) {
      const kind = bullet ? 'ul' : 'ol';
      const item = (bullet ?? numbered)![1]!;
      if (last && last.kind === kind) out[out.length - 1] = { kind, items: [...last.items, item] };
      else out.push({ kind, items: [item] });
    } else if (line.trim() === '') {
      out.push({ kind: 'p', lines: [] });
    } else if (last && last.kind === 'p') {
      out[out.length - 1] = { kind: 'p', lines: [...last.lines, line] };
    } else {
      out.push({ kind: 'p', lines: [line] });
    }
  }
  return out.filter((block) => block.kind !== 'p' || block.lines.length > 0);
}

function renderBlock(block: Block, key: number): ReactNode {
  if (block.kind === 'h') {
    const Heading = `h${block.level}` as const;
    return (
      <Heading key={key} className={styles.mdHeading} dir="auto">
        <MarkdownInline text={block.text} />
      </Heading>
    );
  }
  if (block.kind === 'p') {
    return (
      <p key={key} className={styles.mdParagraph} dir="auto">
        {block.lines.map((line, i) => (
          <span key={i}>
            {i > 0 ? <br /> : null}
            <MarkdownInline text={line} />
          </span>
        ))}
      </p>
    );
  }
  const List = block.kind;
  return (
    <List key={key} className={styles.mdList}>
      {block.items.map((item, i) => (
        <li key={i} dir="auto">
          <MarkdownInline text={item} />
        </li>
      ))}
    </List>
  );
}

/**
 * A section's preview as plain text (the "What the AI uses" list): the
 * markdown markers gone - heading hashes, bullets, numbers, bold, code, a
 * link's address - and its lines joined by " · ". The route sends the
 * section's first characters as stored (ai knowledge.ts, `slice(0, …)`), so
 * the lines and the marks are still there, and a bold may be cut in half.
 */
export function plainPreview(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(HEADING, '$2')
        .replace(BULLET, '$1')
        .replace(NUMBERED, '$1')
        .replace(/\[([^\]\n]+)\]\([^)\s]*\)/g, '$1')
        .replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, '$1$2')
        // A preview is a cut slice: a pair it cut in half leaves one mark.
        .replace(/\*\*/g, '')
        .replace(/`([^`\n]+)`/g, '$1')
        .trim(),
    )
    .filter((line) => line !== '')
    .join(' · ');
}
