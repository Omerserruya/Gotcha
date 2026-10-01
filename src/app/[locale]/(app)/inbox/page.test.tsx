import type { ReactElement, ReactNode } from 'react';
import { isValidElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CustomerOrders } from '@/features/customers/CustomerOrders';
import { ConversationHeader } from '@/features/inbox/ConversationHeader';
import { ConversationList } from '@/features/inbox/ConversationList';
import { PageContainer } from '@/shell/PageContainer';
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

/*
 * ⚠ `ConversationList` now imports the locale-aware `Link`, which pulls in
 *   `next/navigation` — unresolvable in this environment. This page test
 *   inspects the TREE rather than rendering it, so the real Link is never
 *   needed; the mock exists so the module graph loads at all.
 */
vi.mock('@/i18n/navigation', () => ({ Link: 'a' }));

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

describe('⚠⚠ the queue is told which conversation is open', () => {
  /*
   * ════════════════════════════════════════════════════════════════════════
   * FOUND BY A SURVIVING MUTATION, AND IT IS THE SAME GAP AS `onScreen`
   * ════════════════════════════════════════════════════════════════════════
   * `ConversationList` is thoroughly tested for what it does with `openId`,
   * and replacing this page's `openId={c ?? null}` with `null` broke nothing:
   * 149 tests green with the selected state destroyed.
   *
   * ★ Two halves each tested and the join between them tested by neither.
   *   Guards assert hops; this is the hop.
   */
  it('★★ marks the conversation that is OPEN, which with `?c=` is that one', async () => {
    loadInbox.mockResolvedValue(data({ open: row({ id: 'c7' }) }));
    const { default: Page } = await import('./page');
    const tree = await Page({ searchParams: Promise.resolve({ c: 'c7' }) });

    const props = propsOf<{ openId?: string | null }>(tree, ConversationList);
    expect(props?.openId).toBe('c7');
  });

  it('⚠⚠ and with no `?c=` it is the one the loader opened — not nothing', async () => {
    /*
     * Measured on the deployed build: the first conversation open in the
     * pane and no row marked, because the list was told `c`, which was
     * absent. The open conversation is the fact; `c` is one way to choose it.
     */
    const props = propsOf<{ openId?: string | null }>(
      await page({ open: row({ id: 'first' }) }),
      ConversationList,
    );
    expect(props?.openId).toBe('first');
  });

  it('⚠ and passes null when nothing is open, not undefined', async () => {
    /*
     * ★ `null` is "nothing is open"; `undefined` is "nobody said". They read
     *   the same at the call site and differ the moment anyone adds a default.
     */
    const props = propsOf<{ openId?: string | null }>(await page({ open: null }), ConversationList);
    expect(props?.openId).toBeNull();
  });
});

describe('⚠⚠ the verbs are told whether this conversation is resolved', () => {
  /*
   * ════════════════════════════════════════════════════════════════════════
   * THE THIRD TIME TODAY A PROP WAS WIRED AND NOT TESTED
   * ════════════════════════════════════════════════════════════════════════
   * `onScreen` this morning, `openId` this afternoon, now `resolved`. Each
   * time the component was thoroughly tested for what it DOES with the value
   * and nothing checked that the page SUPPLIES it — and each time a mutation
   * found it rather than a reviewer.
   *
   * ★ The pattern is mine to break: the wiring test belongs in the same
   *   commit as the prop, not after a mutation survives.
   */
  it('★★ passes CLOSED through, and nothing else', async () => {
    for (const [status, expected] of [
      ['CLOSED', true],
      ['OPEN', false],
      /*
       * ⚠ WAITING IS THE MOST LIVE STATE IN THE QUEUE — somebody is waiting
       *   for a reply. Treating it as resolved would hide the Resolve button
       *   on exactly the conversations that need resolving.
       */
      ['WAITING', false],
    ] as const) {
      loadInbox.mockResolvedValue(data({ open: { ...data().open, status } }));
      const { default: Page } = await import('./page');
      const tree = await Page({ searchParams: Promise.resolve({}) });

      const props = propsOf<{ resolved?: boolean }>(tree, ConversationVerbs);
      expect(props?.resolved, status).toBe(expected);
    }
  });
});

describe('⚠⚠ the inbox draws its own panels, so the shell’s surface steps aside', () => {
  /*
   * ════════════════════════════════════════════════════════════════════════
   * MEASURED BY RENDERING THE DESIGN, NOT BY READING ITS MARKUP
   * ════════════════════════════════════════════════════════════════════════
   * 02's frame computes to `rgb(18,18,18)` and the three columns are
   * `#FAF8F4` cards floating on it. **Light on near-black is the
   * separation** — and we had light panels on the shell's light work
   * surface, which is why a reviewer asked "what separated????".
   *
   * ★ The shell already paints that frame. What was missing is the screen
   *   saying it owns its own panels, so the surface does not paint over it.
   */
  /*
   * ★ Walked rather than rendered, like everything else in this file: the
   *   async panels are mocked, so there is a TREE to inspect and no DOM.
   */
  const owners = (tree: ReactNode): ReactElement[] => {
    const found: ReactElement[] = [];
    walk(tree, [], (element) => {
      if ((element.props as Record<string, unknown>)['data-owns-panels'] !== undefined) {
        found.push(element);
      }
    });
    return found;
  };

  it('★★ declares `data-owns-panels`, which is what the shell keys on', async () => {
    const claimed = owners(await page());

    expect(claimed).toHaveLength(1);
    expect((claimed[0]!.props as Record<string, unknown>)['data-testid']).toBe('inbox-screen');
  });

  it('★★ and the container bleeds, so the panels reach the frame’s edges', async () => {
    /*
     * ⚠ A SURVIVING MUTATION, CAUGHT IN THE SAME COMMIT THIS TIME. Swapping
     *   `bleed` for `wide` broke nothing: the attribute test above passes
     *   either way, because it is about a different fact.
     *
     * ★ `bleed` removes the 40px gutters and the 1120px cap. Without it the
     *   three panels sit inside a document's margins and the dark frame reads
     *   as a border around a page rather than as the ground they float on —
     *   which is the whole point of the dark.
     */
    let container: ReactElement | null = null;
    walk(await page(), [], (element) => {
      if (element.type === PageContainer) container = element;
    });

    const props = (container as ReactElement | null)?.props as
      { bleed?: boolean; wide?: boolean } | undefined;
    expect(props?.bleed).toBe(true);
  });

  it('⚠ and nothing else on this page claims it', async () => {
    /*
     * ★ The attribute makes an ANCESTOR transparent through `:has()`. A
     *   second element carrying it would be harmless today and confusing the
     *   moment somebody moves one of them — it reads as a local style and
     *   acts at a distance.
     */
    expect(owners(await page())).toHaveLength(1);
  });
});

describe('⚠⚠ two panels, and the Copilot is the chat panel’s wall', () => {
  /*
   * ════════════════════════════════════════════════════════════════════════
   * FROM 02's COMPUTED TREE, NOT FROM ITS MARKUP
   * ════════════════════════════════════════════════════════════════════════
   * The chat panel is `[856x876]`, and INSIDE it a flex row holds the
   * conversation beside `[372x809]` of Copilot at `rgb(23,23,23)` with
   * `r:0 0 18px 18px` — the panel's own bottom-right corner, which only a
   * CHILD can inherit. It is not a third card; it is a wall of the second.
   */
  const ancestorsOf = (tree: ReactNode, target: unknown): string[] => {
    let found: string[] = [];
    const visit = (node: ReactNode, chain: string[]): void => {
      if (Array.isArray(node)) {
        node.forEach((child) => visit(child, chain));
        return;
      }
      if (!isValidElement(node)) return;
      const props = node.props as { className?: string; children?: ReactNode };
      const next = props.className ? [...chain, props.className] : chain;
      if (node.type === target) found = next;
      visit(props.children, next);
    };
    visit(tree, []);
    return found;
  };

  it('★★ the identity panel sits INSIDE the conversation column', async () => {
    const chain = ancestorsOf(await page(), IdentityPanel);
    expect(chain.some((c) => c.includes('conversationColumn'))).toBe(true);
    expect(chain.some((c) => c.includes('contextColumn'))).toBe(true);
  });

  it('⚠⚠ the header sits ABOVE the split, so the Copilot cannot cut through it', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * MEASURED: OUR COPILOT STARTED AT y=12 AND RAN THE FULL 876px
     * ════════════════════════════════════════════════════════════════════════
     * 02: header `[856x67]` across the whole chat panel, then the split
     * `[856x809]`, Copilot at y=79. Ours had the header inside the
     * conversation pane, so the dark wall reached the top of the panel and
     * cut through the name and the three buttons.
     *
     * ★ Asserted as ancestry: the header is in the column and NOT in the
     *   split. Header first, then the split.
     */
    const chain = ancestorsOf(await page(), ConversationHeader);
    expect(chain.some((c) => c.includes('conversationColumn'))).toBe(true);
    expect(chain.some((c) => c.includes('chatBody'))).toBe(false);
    expect(chain.some((c) => c.includes('conversationPane'))).toBe(false);
  });

  it('⚠⚠ and it is still there with nothing open', async () => {
    /*
     * ★ THE BUG MY FIRST ATTEMPT INTRODUCED. The branch was two sections, and
     *   moving the Copilot into the open one silently dropped it from the
     *   empty one — the panel vanished exactly when somebody had nothing
     *   selected. It is now one section with two bodies, and this is the
     *   assertion that keeps it that way.
     */
    const chain = ancestorsOf(await page({ open: null }), IdentityPanel);
    expect(chain.some((c) => c.includes('contextColumn'))).toBe(true);
  });
});

describe('⚠⚠ the page READS `view` — the whole of the bug', () => {
  /*
   * ════════════════════════════════════════════════════════════════════════
   * THE RAIL WROTE `?view=` AND THE PAGE DID NOT READ IT
   * ════════════════════════════════════════════════════════════════════════
   * `searchParams` declared only `c` and `cursor`. Every view rendered the
   * same ten rows under the same heading. This is the hop that was broken, so
   * it is the hop asserted — not the mapping, which has its own tests.
   */
  const withView = async (view: string | undefined) => {
    loadInbox.mockResolvedValue(data());
    const { default: Page } = await import('./page');
    return Page({ searchParams: Promise.resolve(view === undefined ? {} : { view }) });
  };

  it('★★ passes the view to the loader', async () => {
    await withView('resolved');
    expect(loadInbox).toHaveBeenLastCalledWith(undefined, undefined, 'resolved', null);
  });

  it('★★ and to the list, so its heading names the view', async () => {
    const props = propsOf<{ view?: string }>(await withView('mine'), ConversationList);
    expect(props?.view).toBe('mine');
  });

  it('⚠ an invented view falls back to the queue rather than an error', async () => {
    await withView('../../admin');
    expect(loadInbox).toHaveBeenLastCalledWith(undefined, undefined, 'queue', null);
  });

  it('★★ reads `channel` too, and hands it to the loader and the list', async () => {
    loadInbox.mockResolvedValue(data());
    const { default: Page } = await import('./page');
    const tree = await Page({
      searchParams: Promise.resolve({ view: 'active', channel: 'MESSENGER' }),
    });
    expect(loadInbox).toHaveBeenLastCalledWith(undefined, undefined, 'active', 'MESSENGER');
    expect(propsOf<{ channel?: string | null }>(tree, ConversationList)?.channel).toBe('MESSENGER');
  });

  it('★ the header gets the order read the Copilot already has', async () => {
    const orders = { state: 'ok', summary: { orderCount: 6 } };
    loadInbox.mockResolvedValue(data({ orders }));
    const { default: Page } = await import('./page');
    const tree = await Page({ searchParams: Promise.resolve({}) });
    expect(propsOf<{ orders?: unknown }>(tree, ConversationHeader)?.orders).toBe(orders);
  });

  it('⚠ a channel with no chip is "All"', async () => {
    loadInbox.mockResolvedValue(data());
    const { default: Page } = await import('./page');
    await Page({ searchParams: Promise.resolve({ channel: 'GMAIL' }) });
    expect(loadInbox).toHaveBeenLastCalledWith(undefined, undefined, 'queue', null);
  });
});
