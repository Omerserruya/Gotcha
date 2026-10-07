import type { ReactNode } from 'react';

import { Link } from '@/i18n/navigation';
import { safeInternalPath, safeLinkUrl } from '@/lib/safe-url';

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
export function AnswerText({ text }: { readonly text: string }) {
  return <>{blocks(text).map((block, i) => renderBlock(block, i))}</>;
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

function renderBlock(block: Block, key: number): ReactNode {
  if (block.kind === 'p') {
    return (
      <p key={key} className={styles.answer} dir="auto">
        {block.lines.map((line, i) => (
          <span key={i}>
            {i > 0 ? <br /> : null}
            {inline(line)}
          </span>
        ))}
      </p>
    );
  }
  const List = block.kind;
  return (
    <List key={key} className={styles.answerList} dir="auto">
      {block.items.map((item, i) => (
        <li key={i}>{inline(item)}</li>
      ))}
    </List>
  );
}

/** `**bold**`, `` `code` ``, `[label](url)`, `*italic*` / `_italic_` - first match wins, left to right. */
const INLINE =
  /\*\*([^*\n]+)\*\*|`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|\*([^*\s][^*\n]*)\*|_([^_\s][^_\n]*)_/g;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > at) out.push(text.slice(at, index));
    const [whole, bold, code, label, url, italic, underscored] = match;
    const key = `${index}`;
    if (bold !== undefined) out.push(<strong key={key}>{inline(bold)}</strong>);
    else if (code !== undefined) out.push(<code key={key}>{code}</code>);
    else if (label !== undefined) out.push(<AnswerLink key={key} label={label} url={url!} />);
    else out.push(<em key={key}>{italic ?? underscored}</em>);
    at = index + whole.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
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
