import type { ReactElement, ReactNode } from 'react';
import { isValidElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CustomerOrders } from '@/features/customers/CustomerOrders';
import { ConversationList } from '@/features/inbox/ConversationList';
import { ConversationVerbs } from '@/features/inbox/ConversationVerbs';
import { IdentityPanel } from '@/features/inbox/IdentityPanel';
import { MessageStream } from '@/features/inbox/MessageStream';

/**
 * Screen 02, assembled — tested on the tree rather than on the pixels.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ WHY THIS IS A STRUCTURAL TEST AND NOT A RENDER
 * ════════════════════════════════════════════════════════════════════════════
 * All four panels are `async` server components, and **an async server
 * component nested inside another renders nothing** — silently, with no
 * error, no empty element and nothing in a log. It has cost five screens in
 * this project and a capture found it every time.
 *
 * jsdom cannot render an async component at all, so a render-based test would
 * have to resolve them by hand — and resolving them is exactly what the
 * browser will not do for a nested one. **The instrument would repair the
 * defect it was built to find.**
 *
 * The property is structural, so it is checked structurally: walk the element
 * tree the page returns and assert that no async panel is a descendant of
 * another. Each panel's own rendering is covered by its own file, which is
 * the layer where rendering is testable.
 */

const loadInbox = vi.hoisted(() => vi.fn());
vi.mock('@/features/inbox/load-inbox', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  loadInbox,
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
  getFormatter: async () => ({}),
}));
vi.mock('server-only', () => ({}));

/** Every panel that must not be nested inside another. */
const ASYNC_PANELS = new Set<unknown>([
  ConversationList,
  MessageStream,
  IdentityPanel,
  CustomerOrders,
]);

/** Every element in the tree, with the async panels above it. */
function walk(
  node: ReactNode,
  ancestors: readonly unknown[],
  visit: (element: ReactElement, asyncAncestors: readonly unknown[]) => void,
): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, ancestors, visit);
    return;
  }
  if (!isValidElement(node)) return;
  const element = node as ReactElement<{ children?: ReactNode }>;
  visit(element, ancestors);
  const next = ASYNC_PANELS.has(element.type) ? [...ancestors, element.type] : ancestors;
  walk(element.props?.children, next, visit);
}

const found = (tree: ReactNode) => {
  const panels: unknown[] = [];
  const nested: string[] = [];
  walk(tree, [], (element, asyncAncestors) => {
    if (!ASYNC_PANELS.has(element.type)) return;
    panels.push(element.type);
    if (asyncAncestors.length > 0) {
      nested.push(`${(element.type as { name: string }).name} inside ${asyncAncestors.length}`);
    }
  });
  return { panels, nested };
};

const propsOf = <T,>(tree: ReactNode, component: unknown): T | null => {
  let props: T | null = null;
  walk(tree, [], (element) => {
    if (element.type === component) props = element.props as T;
  });
  return props;
};

const row = (over: Record<string, unknown> = {}) => ({
  id: 'conv1',
  status: 'OPEN' as const,
  channel: 'WHATSAPP',
  handledBy: 'ai_agent' as const,
  assignedAgentId: null,
  assignedAiAgentId: 'ai1',
  isHandedOver: false,
  lastMessageAt: '2026-09-26T08:00:00.000Z',
  customerName: 'Noa',
  customerExternalId: '+972500000000',
  lastMessageBody: 'Where is my order?',
  lastMessageDirection: 'INBOUND' as const,
  ...over,
});

const data = (over: Record<string, unknown> = {}) => ({
  rows: [row()],
  hasMore: false,
  nextCursor: null,
  undatedCount: 0,
  open: row(),
  messages: [],
  timeline: null,
  orders: null,
  meId: 'me',
  colleagues: [{ id: 'u2', name: 'Dana' }],
  greeting: null,
  ...over,
});

const page = async (over: Record<string, unknown> = {}) => {
  loadInbox.mockResolvedValue(data(over));
  const { default: Page } = await import('./page');
  return Page({ searchParams: Promise.resolve({}) });
};

beforeEach(() => {
  loadInbox.mockReset();
});

describe('★★ four panels, and none of them inside another', () => {
  it('★★ all four are mounted', async () => {
    const { panels } = found(await page());

    expect(panels).toContain(ConversationList);
    expect(panels).toContain(MessageStream);
    expect(panels).toContain(IdentityPanel);
    expect(panels).toContain(CustomerOrders);
  });

  it('★★ NONE is a descendant of another — the trap that has cost five screens', async () => {
    /*
     * The failure mode is not an error. The inner component simply does not
     * render, the page looks finished, and the missing panel is discovered in
     * a screenshot days later.
     */
    expect(found(await page()).nested).toEqual([]);
  });

  it('★★ still true with nothing open, where the markup branches', async () => {
    // The branch that swaps the conversation column for a sentence is where a
    // panel would most easily end up in the wrong place.
    const { panels, nested } = found(await page({ rows: [], open: null, messages: null }));

    expect(nested).toEqual([]);
    // The queue and the context panels are still mounted; the stream is not,
    // because there is no conversation to stream.
    expect(panels).toContain(ConversationList);
    expect(panels).toContain(IdentityPanel);
    expect(panels).toContain(CustomerOrders);
    expect(panels).not.toContain(MessageStream);
  });
});

describe('★★ 04d’s commerce panel, not a second one', () => {
  it('★★ is given the orders the page already read, and the conversation to act through', async () => {
    /*
     * A second commerce contract would be two answers about somebody's money,
     * both rendered confidently, on the same screen. `CustomerOrders` takes
     * its data as a prop and reads nothing itself.
     */
    const orders = { state: 'ok', data: {} };
    const props = propsOf<{ orders: unknown; conversationId: string | null }>(
      await page({ orders }),
      CustomerOrders,
    );

    expect(props?.orders).toBe(orders);
    expect(props?.conversationId).toBe('conv1');
  });

  it('★ gets a null conversation id when nothing is open, so its actions are absent', async () => {
    // The endpoint has nowhere to route, and controls that cannot work are
    // better absent than broken.
    const props = propsOf<{ conversationId: string | null }>(
      await page({ rows: [], open: null, messages: null }),
      CustomerOrders,
    );
    expect(props?.conversationId).toBeNull();
  });
});

describe('★★ what the page decides before the verbs are drawn', () => {
  const verbs = async (over: Record<string, unknown>) =>
    propsOf<{
      mine: boolean;
      handedOver: boolean;
      hasAiEmployee: boolean;
      greeting: boolean | null;
    }>(await page(over), ConversationVerbs);

  it('★★ a conversation assigned to me is mine', async () => {
    expect(await verbs({ open: row({ assignedAgentId: 'me' }) })).toMatchObject({ mine: true });
  });

  it('★★ an unknown viewer owns nothing, rather than owning everything', async () => {
    /*
     * THE COMPARISON THAT MUST NOT BE MADE. `meId === null` is a failed
     * `/api/auth/me`. Comparing null to a null `assignedAgentId` would make
     * every UNASSIGNED conversation "mine" — hiding the claim button on
     * exactly the conversations that need claiming, and offering a transfer
     * that the route refuses.
     */
    expect(await verbs({ meId: null, open: row({ assignedAgentId: null }) })).toMatchObject({
      mine: false,
    });
  });

  it('★ a conversation held by somebody else is not mine', async () => {
    expect(await verbs({ open: row({ assignedAgentId: 'someone-else' }) })).toMatchObject({
      mine: false,
    });
  });

  it('★★ the AI binding comes from the row, and null means none', async () => {
    // Two-state only because it was checked: the list route puts no `select`
    // on the conversation, so `assignedAiAgentId` really is on the wire.
    expect(await verbs({ open: row({ assignedAiAgentId: null }) })).toMatchObject({
      hasAiEmployee: false,
    });
    expect(await verbs({ open: row({ assignedAiAgentId: 'ai1' }) })).toMatchObject({
      hasAiEmployee: true,
    });
  });

  it('★★ an unreadable greeting setting stays null all the way to the control', async () => {
    // Not coerced to false anywhere along the path. `false` would promise the
    // customer hears nothing when a message is about to be sent to them.
    expect(await verbs({ greeting: null })).toMatchObject({ greeting: null });
    expect(await verbs({ greeting: true })).toMatchObject({ greeting: true });
    expect(await verbs({ greeting: false })).toMatchObject({ greeting: false });
  });
});
