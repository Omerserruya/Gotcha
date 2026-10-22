import { describe, expect, it } from 'vitest';

import { nodeSchema, type AutomationNode } from '@/api/contracts/automations';

import {
  NODE_W,
  appendTarget,
  cartFirstSend,
  viaOf,
  beforeFirstWait,
  changeRefusal,
  changeType,
  defaultData,
  fileNameOf,
  ROW_H,
  freeHandles,
  insertAfter,
  insertBetween,
  insertRefusal,
  layout,
  onlyThrough,
  outputsOf,
  removeStep,
  type Graph,
} from './graph';

const node = (id: string, type: string, data: Record<string, unknown> = {}): AutomationNode =>
  nodeSchema.parse({ id, type, data });
const edge = (source: string, target: string, sourceHandle: string | null = null) => ({
  id: `${source}-${target}`,
  source,
  target,
  sourceHandle,
});

/** 09d's example: trigger → open now? → yes: buttons → wait for reply. */
const missed: Graph = {
  nodes: [
    node('t', 'automation_trigger'),
    node('h', 'opening_hours'),
    node('b', 'send_buttons', {
      text: 'Hi',
      buttons: [
        { id: 'call', title: 'Call me back' },
        { id: 'write', title: 'Write here' },
      ],
    }),
    node('w', 'wait_for_reply', { timeoutMs: 1_800_000 }),
    node('ai', 'hand_to_ai', { aiAgentId: 'a1' }),
  ],
  edges: [edge('t', 'h'), edge('h', 'b', 'open'), edge('b', 'w'), edge('w', 'ai', 'btn:write')],
};

let n = 0;
const newId = () => `n${++n}`;

describe("★★ outputs mirror the route's outputsOf - a branch it lacks is refused", () => {
  it('fixed branches; wait for reply: a branch per button of the send before it, reply, timeout', () => {
    expect(outputsOf(missed.nodes[1]!, missed)).toEqual(['open', 'closed']);
    expect(outputsOf(missed.nodes[3]!, missed)).toEqual([
      'btn:call',
      'btn:write',
      'reply',
      'timeout',
    ]);
    expect(outputsOf(missed.nodes[4]!, missed)).toEqual([]);
    expect(outputsOf(node('l', 'language', { languages: ['he', 'en'] }), missed)).toEqual([
      'he',
      'en',
      'other',
    ]);
  });

  it('a "+" for every output with nothing attached', () => {
    expect(freeHandles(missed.nodes[1]!, missed)).toEqual(['closed']);
    expect(freeHandles(missed.nodes[3]!, missed)).toEqual(['btn:call', 'reply', 'timeout']);
    expect(freeHandles(missed.nodes[2]!, missed)).toEqual([]);
  });
});

describe('★ edits', () => {
  it('insert after a branch: the edge carries the branch; a plain next carries none', () => {
    const added = insertAfter(missed, 'h', 'closed', 'send_message_text', newId);
    const made = added.graph.edges.find((e) => e.target === added.id);
    expect(made).toMatchObject({ source: 'h', sourceHandle: 'closed' });
    expect(added.graph.nodes.find((x) => x.id === added.id)?.data).toEqual({ text: '' });
    const plain = insertAfter(missed, 't', 'next', 'add_tag', newId);
    expect(plain.graph.edges.find((e) => e.target === plain.id)?.sourceHandle).toBeNull();
  });

  it('a plain step with one way on is spliced out; a branching one takes what only it leads to', () => {
    const spliced = removeStep(missed, 'b');
    expect(spliced.edges).toContainEqual(
      expect.objectContaining({ source: 'h', target: 'w', sourceHandle: 'open' }),
    );
    expect(spliced.nodes.map((x) => x.id)).not.toContain('b');
    expect(onlyThrough(missed, 'w')).toEqual(['w', 'ai']);
    expect(removeStep(missed, 'w').nodes.map((x) => x.id)).toEqual(['t', 'h', 'b']);
    expect(removeStep(missed, 't')).toBe(missed);
  });
});

describe('★ layout: top down, a parent over its children', () => {
  it('rows by depth; one child sits under its parent; siblings side by side', () => {
    const { at } = layout(missed);
    expect(at.get('t')?.y).toBe(0);
    expect(at.get('w')?.y).toBe(3 * ROW_H);
    expect(at.get('h')?.x).toBe(at.get('t')?.x);
    const forked = insertAfter(missed, 'h', 'closed', 'send_message_text', newId);
    const placed = layout(forked.graph).at;
    expect(placed.get(forked.id)!.x).toBeGreaterThanOrEqual(placed.get('b')!.x + NODE_W);
    expect(placed.get('h')!.x).toBe((placed.get('b')!.x + placed.get(forked.id)!.x) / 2);
  });

  it('a step nothing reaches still shows, on its own row', () => {
    const loose: Graph = { nodes: [...missed.nodes, node('x', 'add_tag')], edges: missed.edges };
    expect(layout(loose).at.get('x')?.y).toBe(5 * ROW_H);
  });
});

describe('★ a file step’s name: the executor’s `filename`, an old draft’s `fileName` still read', () => {
  it('reads filename first, fileName from an older draft, nothing as empty', () => {
    expect(fileNameOf({ filename: 'menu.pdf', fileName: 'old.pdf' })).toBe('menu.pdf');
    expect(fileNameOf({ fileName: 'old.pdf' })).toBe('old.pdf');
    expect(fileNameOf({})).toBe('');
    expect(fileNameOf({ filename: 7 })).toBe('');
  });

  it('a new file step is made with `filename`, never `fileName`', () => {
    const step = defaultData('send_message_file', () => 'x');
    expect(step).toHaveProperty('filename', '');
    expect(step).not.toHaveProperty('fileName');
  });
});

describe('★★ AU8 - a step changes type in its place', () => {
  const g = (nodes: AutomationNode[], edges: ReturnType<typeof edge>[]): Graph => ({
    nodes,
    edges,
  });

  it('★ message → file: same id, same lines, the words kept where the new type has them', () => {
    const graph = g(
      [
        node('t', 'automation_trigger'),
        node('m', 'send_message_text', { text: 'hi' }),
        node('x', 'add_tag'),
      ],
      [edge('t', 'm'), edge('m', 'x')],
    );
    const next = changeType(graph, 'm', 'send_buttons')!;
    const m = next.nodes.find((n) => n.id === 'm')!;
    expect(m.type).toBe('send_buttons');
    expect(m.data.text).toBe('hi');
    expect(next.edges).toEqual(graph.edges);
    expect(changeRefusal(graph, 'm', 'send_message_file')).toBeNull();
  });

  it('★★ buttons with a wait for their reply right after: refused - the wait reads them', () => {
    const graph = g(
      [node('t', 'automation_trigger'), node('b', 'send_buttons'), node('w', 'wait_for_reply')],
      [edge('t', 'b'), edge('b', 'w')],
    );
    expect(changeRefusal(graph, 'b', 'send_message_text')).toBe('reply_pair');
    expect(changeType(graph, 'b', 'send_message_text')).toBeNull();
  });

  it('★★ to a final step while something follows: refused', () => {
    const graph = g(
      [node('t', 'automation_trigger'), node('m', 'send_message_text'), node('x', 'add_tag')],
      [edge('t', 'm'), edge('m', 'x')],
    );
    expect(changeRefusal(graph, 'm', 'close_conversation')).toBe('terminal_has_next');
    // Nothing after it: allowed.
    const last = g(
      [node('t', 'automation_trigger'), node('m', 'send_message_text')],
      [edge('t', 'm')],
    );
    expect(changeRefusal(last, 'm', 'close_conversation')).toBeNull();
  });

  it('★ a branch the new type does not have: refused, never a hanging step', () => {
    const graph = g(
      [node('t', 'automation_trigger'), node('h', 'opening_hours'), node('o', 'add_tag')],
      [edge('t', 'h'), edge('h', 'o', 'open')],
    );
    expect(changeRefusal(graph, 'h', 'send_message_text')).toBe('branches_lost');
  });

  it('the trigger, and the same type: never changed', () => {
    const graph = g([node('t', 'automation_trigger')], []);
    expect(changeRefusal(graph, 't', 'send_message_text')).toBe('trigger');
    expect(changeType(graph, 't', 'send_message_text')).toBeNull();
    const one = g(
      [node('t', 'automation_trigger'), node('m', 'send_message_text')],
      [edge('t', 'm')],
    );
    expect(changeRefusal(one, 'm', 'send_message_text')).toBe('same');
  });
});

describe('★★ AU9 - a step on a line, between two steps', () => {
  const plain = { automation: false, safe: () => true };
  const g = (nodes: AutomationNode[], edges: ReturnType<typeof edge>[]): Graph => ({
    nodes,
    edges,
  });

  it('★★ the line keeps its id and branch ("unreachable" too) and leads to the new step, which leads on', () => {
    const graph = g(
      [
        node('t', 'automation_trigger'),
        node('a', 'send_message_text'),
        node('b', 'send_message_text'),
      ],
      [edge('t', 'a'), edge('a', 'b', 'unreachable')],
    );
    const line = graph.edges[1]!;
    let n = 0;
    const made = insertBetween(graph, line, 'add_tag', () => `n${++n}`, plain)!;
    expect(made.id).toBe('n1');
    expect(made.graph.edges).toContainEqual({ ...line, target: 'n1' });
    expect(made.graph.edges).toContainEqual(
      expect.objectContaining({ source: 'n1', target: 'b', sourceHandle: null }),
    );
    expect(made.graph.edges).toHaveLength(3);
    expect(made.graph.nodes.map((x) => x.id)).toEqual(['t', 'a', 'b', 'n1']);
  });

  it('★★ never between buttons and the wait that reads them', () => {
    const graph = g(
      [node('t', 'automation_trigger'), node('b', 'send_buttons'), node('w', 'wait_for_reply')],
      [edge('t', 'b'), edge('b', 'w')],
    );
    expect(insertRefusal(graph, graph.edges[1]!, 'add_tag', plain)).toBe('reply_pair');
    expect(insertBetween(graph, graph.edges[1]!, 'add_tag', () => 'x', plain)).toBeNull();
  });

  it('a final step, or one with branches, never on a line', () => {
    const graph = g([node('t', 'automation_trigger'), node('a', 'add_tag')], [edge('t', 'a')]);
    expect(insertRefusal(graph, graph.edges[0]!, 'close_conversation', plain)).toBe('terminal');
    expect(insertRefusal(graph, graph.edges[0]!, 'opening_hours', plain)).toBe('branching');
    expect(insertRefusal(graph, graph.edges[0]!, 'send_message_text', plain)).toBeNull();
  });

  it('★★ a comment automation, before its first wait: only comment-safe; after it, anything', () => {
    const graph = g(
      [
        node('t', 'automation_trigger'),
        node('w', 'wait_for_reply'),
        node('a', 'send_message_text'),
        node('b', 'add_tag'),
      ],
      [edge('t', 'w'), edge('w', 'a', 'reply'), edge('a', 'b')],
    );
    const comments = { automation: true, safe: (type: string) => type === 'send_message_text' };
    expect([...beforeFirstWait(graph)].sort()).toEqual(['t', 'w']);
    expect(insertRefusal(graph, graph.edges[0]!, 'add_tag', comments)).toBe('comment_unsafe');
    expect(insertRefusal(graph, graph.edges[0]!, 'send_message_text', comments)).toBeNull();
    // After the wait: anything.
    expect(insertRefusal(graph, graph.edges[2]!, 'add_tag', comments)).toBeNull();
    // Not a comment automation: anything.
    expect(
      insertRefusal(graph, graph.edges[0]!, 'add_tag', { ...comments, automation: false }),
    ).toBeNull();
  });
});

describe('★ AU6: a library step with no step chosen goes after the deepest one with a way out', () => {
  const g = (nodes: AutomationNode[], edges: ReturnType<typeof edge>[]): Graph => ({
    nodes,
    edges,
  });

  it('a line: after its last step', () => {
    const line = g(
      [node('t', 'automation_trigger'), node('a', 'add_tag'), node('b', 'add_tag')],
      [edge('t', 'a'), edge('a', 'b')],
    );
    expect(appendTarget(line)).toEqual({ id: 'b', handle: 'next' });
  });

  it('a branch ending in a closed conversation: the other branch of its split', () => {
    const split = g(
      [
        node('t', 'automation_trigger'),
        node('h', 'opening_hours'),
        node('x', 'close_conversation'),
      ],
      [edge('t', 'h'), edge('h', 'x', 'open')],
    );
    expect(appendTarget(split)).toEqual({ id: 'h', handle: 'closed' });
  });

  it('deeper wins over a free branch above it; at one depth, the first of the row', () => {
    const deeper = g(
      [node('t', 'automation_trigger'), node('h', 'opening_hours'), node('a', 'add_tag')],
      [edge('t', 'h'), edge('h', 'a', 'open')],
    );
    expect(appendTarget(deeper)).toEqual({ id: 'a', handle: 'next' });
    const row = g(
      [
        node('t', 'automation_trigger'),
        node('h', 'opening_hours'),
        node('a', 'add_tag'),
        node('c', 'add_tag'),
      ],
      [edge('t', 'h'), edge('h', 'a', 'open'), edge('h', 'c', 'closed')],
    );
    expect(appendTarget(row)).toEqual({ id: 'a', handle: 'next' });
  });

  it('every way out taken: nowhere', () => {
    const closed = g(
      [node('t', 'automation_trigger'), node('x', 'close_conversation')],
      [edge('t', 'x')],
    );
    expect(appendTarget(closed)).toBeNull();
  });
});

describe('★★ AU4: a cart reminder - the first message names the channel, and has "if they can\'t be reached"', () => {
  const g = (nodes: AutomationNode[], edges: ReturnType<typeof edge>[], cart = true): Graph => ({
    nodes,
    edges,
    cart,
  });
  const reminder = () =>
    g(
      [
        node('t', 'automation_trigger'),
        node('w', 'wait', { delayMs: 60_000 }),
        node('m', 'send_message_text', { text: 'Your cart', via: 'whatsapp' }),
        node('n', 'send_message_text', { text: 'Still there?' }),
      ],
      [edge('t', 'w'), edge('w', 'm'), edge('m', 'n')],
    );

  it('the first send step past a wait has the exit; a later one does not', () => {
    const cart = reminder();
    expect(cartFirstSend(cart)?.id).toBe('m');
    expect(outputsOf(cart.nodes[2]!, cart)).toEqual(['next', 'unreachable']);
    expect(outputsOf(cart.nodes[3]!, cart)).toEqual(['next']);
    expect(freeHandles(cart.nodes[2]!, cart)).toEqual(['unreachable']);
  });

  it('not a cart reminder: no such exit', () => {
    const plain = { ...reminder(), cart: false };
    expect(outputsOf(plain.nodes[2]!, plain)).toEqual(['next']);
  });

  it('the step on the exit is never itself "the first message"', () => {
    const cart = g(
      [
        node('t', 'automation_trigger'),
        node('e', 'send_message_text', { via: 'email' }),
        node('m', 'send_message_template'),
      ],
      [edge('t', 'm'), edge('m', 'e', 'unreachable')],
    );
    expect(cartFirstSend(cart)?.id).toBe('m');
    expect(outputsOf(cart.nodes[1]!, cart)).toEqual(['next']);
  });

  it('an "unreachable" line from elsewhere (the route refuses it) is never walked to find the first message - as the route', () => {
    const odd = g(
      [
        node('t', 'automation_trigger'),
        node('h', 'opening_hours'),
        node('e', 'send_message_text', { via: 'email' }),
        node('m', 'send_message_text', { via: 'whatsapp' }),
      ],
      [edge('t', 'h'), edge('h', 'e', 'unreachable'), edge('h', 'm', 'open')],
    );
    expect(cartFirstSend(odd)?.id).toBe('m');
  });

  it('every edit keeps the reminder a reminder', () => {
    const cart = reminder();
    expect(insertAfter(cart, 'n', 'next', 'add_tag', () => 'x').graph.cart).toBe(true);
    expect(removeStep(cart, 'n').cart).toBe(true);
    expect(changeType(cart, 'n', 'send_message_file')?.cart).toBe(true);
    expect(
      insertBetween(cart, cart.edges[2]!, 'add_tag', () => 'y', {
        automation: false,
        safe: () => true,
      })?.graph.cart,
    ).toBe(true);
  });

  it('the channel a step names: a template is WhatsApp; a message its via; none, none', () => {
    expect(viaOf(node('a', 'send_message_template'))).toBe('whatsapp');
    expect(viaOf(node('a', 'send_message_text', { via: 'EMAIL' }))).toBe('email');
    expect(viaOf(node('a', 'send_message_text', {}))).toBeNull();
    expect(viaOf(node('a', 'send_message_text', { via: 'sms' }))).toBeNull();
  });
});
