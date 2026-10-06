import { readFileSync } from 'node:fs';

import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ConversationStream, OrdersChip } from './ConversationDetail';
import type { ConversationDetail } from './load-inbox';
import { MessageStream } from './MessageStream';
import { StreamPin } from './StreamPin';

vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string, values?: Record<string, unknown>) =>
    `${key}${values ? JSON.stringify(values) : ''}`,
}));
vi.mock('@/i18n/navigation', () => ({ Link: 'a' }));
vi.mock('server-only', () => ({}));

/*
 * These are the components that read the second round inside `<Suspense>`.
 * The page test checks they are mounted and keyed; this checks what each one
 * hands on — the half of the join the page test cannot see, because it does
 * not run them.
 */
const detail = (over: Partial<ConversationDetail> = {}): Promise<ConversationDetail> =>
  Promise.resolve({
    messages: [],
    timeline: null,
    orders: null,
    ...over,
  } as ConversationDetail);

const propsIn = <T,>(tree: ReactNode, type: unknown): T | null => {
  let found: T | null = null;
  const visit = (node: ReactNode): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isValidElement(node)) return;
    const element = node as ReactElement<{ children?: ReactNode }>;
    if (element.type === type) found = element.props as T;
    visit(element.props.children);
  };
  visit(tree);
  return found;
};

describe('★★ ConversationStream — the stream and the pin', () => {
  it('★★ hands the messages and the channel to the stream', async () => {
    const messages = [{ id: 'm1' }] as never;
    const tree = await ConversationStream({
      detail: detail({ messages }),
      conversationId: 'c7',
      channel: 'WHATSAPP',
    });
    const stream = propsIn<{ messages: unknown; channel: unknown }>(tree, MessageStream);
    expect(stream?.messages).toBe(messages);
    expect(stream?.channel).toBe('WHATSAPP');
  });

  it('⚠⚠ pins the stream to its latest message — it opened at the oldest', async () => {
    const tree = await ConversationStream({
      detail: detail(),
      conversationId: 'c7',
      channel: null,
    });
    expect(propsIn<{ conversationId: string }>(tree, StreamPin)?.conversationId).toBe('c7');
  });
});

describe('★ OrdersChip draws only a count it can stand behind', () => {
  it('nothing for no count', async () => {
    expect(await OrdersChip({ detail: detail() })).toBeNull();
  });

  it('"Returning" for more than one', async () => {
    const chip = await OrdersChip({
      detail: detail({ orders: { state: 'ok', summary: { orderCount: 6 } } as never }),
    });
    expect(JSON.stringify(chip)).toContain('open.orders.returning');
  });
});

describe('★★ placeholders are the size of what they stand in for — nothing jumps', () => {
  const css = readFileSync('src/features/inbox/Inbox.module.css', 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  const rule = (selector: string) =>
    new RegExp(`(?:^|\\n)\\s*${selector.replace(/[.[\]'=]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(
      css,
    )?.[1] ?? '';

  it('★ a queue row: the real row’s padding, around 15 + 15 + 17 at gap 4', () => {
    expect(rule('.skeletonRow')).toMatch(/padding:\s*13px var\(--space-16\)/);
    expect(rule(".skeletonLine[data-size='name']")).toMatch(/block-size:\s*15px/);
    expect(rule(".skeletonLine[data-size='preview']")).toMatch(/block-size:\s*15px/);
    expect(rule(".skeletonLine[data-size='tag']")).toMatch(/block-size:\s*17px/);
  });

  it('★ the queue title line is 16 — the row it sits in is 16', () => {
    expect(rule(".skeletonLine[data-size='title']")).toMatch(/block-size:\s*16px/);
  });

  it('★ the composer card is its idle 86', () => {
    expect(rule('.skeletonComposer')).toMatch(/block-size:\s*86px/);
  });

  it('⚠ the pulse stops for anyone who asked for less motion', () => {
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce[\s\S]*?animation:\s*none/);
  });
});
