import type { ReactNode } from 'react';

import type { AnswerSource } from '@/api/contracts/assistant-threads';
import { Link } from '@/i18n/navigation';
import { safeInternalPath, safeLinkUrl } from '@/lib/safe-url';

import { SourceChip } from './AnswerBlocks';
import styles from './HomeConversation.module.css';

/**
 * An answer's text in the contract's markdown subset (assistant-threads-v1
 * §1): bold, italics, bullet and numbered lists, inline code, and links. A
 * link is a link only when it is `http(s)://` or an in-app path starting
 * with `/`; anything else is its label as plain text. No raw HTML, images or
 * tables - and none is ever produced: this builds elements, it never parses
 * HTML. While the text streams, a mark not closed yet reads as itself.
 *
 * Each block reads in its own direction (`dir="auto"`): a Hebrew answer
 * right to left, its list markers on the right.
 */
export function AnswerText({
  text,
  sources = [],
}: {
  readonly text: string;
  /** Stage 2: what `[^sN]` cites - drawn as that source's chip where it stands. */
  readonly sources?: readonly AnswerSource[];
}) {
  return <>{blocks(text).map((block, i) => renderBlock(block, i, sources))}</>;
}

type Block =
  | { readonly kind: 'p'; readonly lines: readonly string[] }
  | { readonly kind: 'ul' | 'ol'; readonly items: readonly string[] };

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

function blocks(text: string): Block[] {
  const out: Block[] = [];
  for (const line of text.split('\n')) {
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    const last = out.at(-1);
    if (bullet || numbered) {
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

function renderBlock(block: Block, key: number, sources: readonly AnswerSource[]): ReactNode {
  if (block.kind === 'p') {
    return (
      <p key={key} className={styles.answer} dir="auto">
        {block.lines.map((line, i) => (
          <span key={i}>
            {i > 0 ? <br /> : null}
            {inline(line, sources)}
          </span>
        ))}
      </p>
    );
  }
  const List = block.kind;
  return (
    <List key={key} className={styles.answerList} dir="auto">
      {block.items.map((item, i) => (
        <li key={i}>{inline(item, sources)}</li>
      ))}
    </List>
  );
}

/**
 * `[^s1]` (a citation, stage 2), `**bold**`, `` `code` ``, `[label](url)`,
 * `*italic*` / `_italic_` - first
 * match wins, left to right. Italics only at a word's edge: inside a word a
 * `_` or `*` is part of it - `SHOPIFY_LIVE_CHAT` read as "SHOPIFY*LIVE*CHAT"
 * (dev, 2026-10-07), and `5*3*2` is arithmetic.
 */
const INLINE =
  /\s*((?:\[\^s\d+\])+)([.,;:!?]*)|\*\*([^*\n]+)\*\*|`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|(?<![\p{L}\p{N}_*])\*([^*\s][^*\n]*?)\*(?![\p{L}\p{N}_*])|(?<![\p{L}\p{N}_])_([^_\s][^_\n]*?)_(?![\p{L}\p{N}_])/gu;

/**
 * ★★ A CITATION NEVER WRAPS ALONE (supervisor, measured on dev, he at 1440):
 * "…(Shopify)" ended one line and the chip started the next, its full stop
 * beside it. One group - the word before it, its chips, the punctuation
 * after - that does not break (`white-space: nowrap`); the space before the
 * chips is not drawn (the chip's own margin stands for it).
 *
 * ⚠ Measured in Chromium: a chip is an inline box, and the line may break
 *   right before it whatever joins the text - a word joiner did not hold it.
 *   Only the word inside the group does.
 */
function inline(
  text: string,
  sources: readonly AnswerSource[] = [],
  citations = true,
): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    const before = index > at ? text.slice(at, index) : '';
    const [whole, cites, punctuation, bold, code, label, url, italic, underscored] = match;
    const key = `${index}`;
    if (cites !== undefined && !citations) {
      // Not an answer: `[^s1]` is the text's own, and stays as written.
      out.push(before + whole);
    } else if (cites !== undefined) {
      // Its sources' chips. Not known yet (the sources come after the text)
      // or never: nothing - the marker itself is never shown.
      const chips = [...cites.matchAll(/\[\^(s\d+)\]/g)].flatMap(([, id], i) => {
        const source = sources.find((s) => s.id === id);
        return source ? [<SourceChip key={i} source={source} inline />] : [];
      });
      // The last word of the text before goes into the group with them.
      const cut = before.search(/\S+$/);
      const word = cut === -1 ? '' : before.slice(cut);
      if (cut > 0) out.push(before.slice(0, cut));
      out.push(
        <span key={key} className={styles.citeGroup}>
          {word}
          {chips}
          {punctuation}
        </span>,
      );
    } else {
      if (before) out.push(before);
      if (bold !== undefined)
        out.push(<strong key={key}>{inline(bold, sources, citations)}</strong>);
      else if (code !== undefined) out.push(<code key={key}>{code}</code>);
      else if (label !== undefined) out.push(<AnswerLink key={key} label={label} url={url!} />);
      else out.push(<em key={key}>{italic ?? underscored}</em>);
    }
    at = index + whole.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/**
 * The same inline marks - bold, italics, code, safe links - for text that is
 * not an answer (K6's document drawer): no citations, so a `[^s1]` in it is
 * left as written. Builds elements; never parses HTML.
 */
export function MarkdownInline({ text }: { readonly text: string }) {
  return <>{inline(text, [], false)}</>;
}

/** In-app: the app's own link (locale, base path). Out: a new tab. Neither: the label. */
function AnswerLink({ label, url }: { readonly label: string; readonly url: string }) {
  if (url.startsWith('/')) {
    const path = safeInternalPath(url);
    return path ? <Link href={path}>{label}</Link> : <>{label}</>;
  }
  const safe = safeLinkUrl(url);
  if (!safe || !/^https?:\/\//i.test(safe)) return <>{label}</>;
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer">
      {label}
    </a>
  );
}
