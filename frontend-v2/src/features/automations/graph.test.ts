import { describe, expect, it } from 'vitest';

import { nodeSchema, type AutomationNode } from '@/api/contracts/automations';

import {
  NODE_W,
  changeRefusal,
  changeType,
  defaultData,
  fileNameOf,
  ROW_H,
  freeHandles,
  insertAfter,
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
