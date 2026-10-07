import { describe, expect, it } from 'vitest';

import { TRIGGER_NODE, outputsOf, type Graph } from './graph';
import { TEMPLATES, needsFilling, templateOf } from './templates';

const words = {
  keyword: 'catalogue',
  welcome: 'Hi {{first_name}}, thanks.',
  adText: 'Hi {{first_name}}, thanks for writing from our ad.',
  prices: 'Prices',
  talk: 'Talk to us',
};
let n = 0;
const newId = () => `id${++n}`;

/** The route's own rules a template must pass (validateAutomation / validateGraph), mirrored. */
function routeIssues(graph: Graph): readonly string[] {
  const issues: string[] = [];
  const triggers = graph.nodes.filter((x) => x.type === TRIGGER_NODE);
  if (triggers.length !== 1) issues.push('trigger_node');
  else if (!graph.edges.some((e) => e.source === triggers[0]!.id)) issues.push('no_steps');
  for (const e of graph.edges) {
    const source = graph.nodes.find((x) => x.id === e.source);
    if (!source || !graph.nodes.some((x) => x.id === e.target)) issues.push('broken_edge');
    else if (!outputsOf(source, graph).includes(e.sourceHandle ?? 'next'))
      issues.push('unknown_branch');
  }
  return issues;
}

describe('★★ a template that runs today makes a real draft (Omer, 2026-10-07)', () => {
  const runnable = TEMPLATES.filter((t) => t.build !== null);

  it('six of them, each with its trigger', () => {
    expect(runnable.map((t) => [t.key, t.trigger])).toEqual([
      ['fileOnKeyword', 'message_received'],
      ['afterHours', 'message_received'],
      ['welcome', 'new_customer'],
      ['tagNotify', 'tag_added'],
      ['cart', 'cart_abandoned'],
      ['fromAd', 'message_from_ad'],
    ]);
  });

  it.each(runnable.map((t) => [t.key, t] as const))(
    "%s passes the route's rules; its only gaps are what the author fills in",
    (_key, template) => {
      const graph = template.build!(words, newId);
      expect(routeIssues(graph)).toEqual([]);
      const steps = graph.nodes.filter((x) => x.type !== TRIGGER_NODE);
      // Every empty required field is marked "to fill in" - and nothing else is.
      for (const step of steps) {
        const missing =
          (step.type === 'send_message_text' && !String(step.data.text ?? '').trim()) ||
          (step.type === 'send_message_file' && !String(step.data.url ?? '').trim()) ||
          (step.type === 'notify_team' && !String(step.data.message ?? '').trim()) ||
          (step.type === 'send_message_template' && !String(step.data.templateId ?? '').trim()) ||
          (step.type === 'hand_to_ai' && !String(step.data.aiAgentId ?? '').trim());
        expect(needsFilling(step)).toBe(missing);
      }
    },
  );

  it("the keyword and the welcome are prefilled, in the author's words", () => {
    expect(templateOf('fileOnKeyword')!.build!(words, newId).config).toEqual({
      keywords: ['catalogue'],
      match: 'contains',
    });
    const hello = templateOf('welcome')!.build!(words, newId).nodes[1]!;
    expect(hello.data.text).toBe('Hi {{first_name}}, thanks.');
    expect(needsFilling(hello)).toBe(false);
  });

  it('after hours answers on "closed" only - while open, the employee does', () => {
    const graph = templateOf('afterHours')!.build!(words, newId);
    expect(graph.edges.map((e) => e.sourceHandle)).toEqual([null, 'closed']);
  });
});

describe('★ no event source yet: nothing to build', () => {
  it.each(['missedCall', 'review', 'comment'])('%s', (key) => {
    expect(templateOf(key)?.build).toBeNull();
  });
});

describe('★ the cart and the ad (Backend 972ae66d)', () => {
  it('cart: after 2 hours a template, a day later another - both to choose', () => {
    const graph = templateOf('cart')!.build!(words, newId);
    expect(graph.config).toEqual({ delayMinutes: 120 });
    expect(graph.nodes.map((x) => x.type)).toEqual([
      'automation_trigger',
      'send_message_template',
      'wait',
      'send_message_template',
    ]);
    expect(graph.nodes.filter(needsFilling).map((x) => x.type)).toEqual([
      'send_message_template',
      'send_message_template',
    ]);
  });

  it('from an ad: the buttons by name, "Talk to us" hands to an employee on its own branch', () => {
    const graph = templateOf('fromAd')!.build!(words, newId);
    const ask = graph.nodes[1]!;
    expect(ask.data.buttons).toEqual([
      { id: 'prices', title: 'Prices' },
      { id: 'talk', title: 'Talk to us' },
    ]);
    expect(graph.edges.map((e) => e.sourceHandle)).toEqual([null, null, 'btn:talk']);
  });
});
