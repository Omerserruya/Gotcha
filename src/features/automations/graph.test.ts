import { describe, expect, it } from 'vitest';

import { nodeSchema, type AutomationNode } from '@/api/contracts/automations';

import {
  NODE_W,
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
