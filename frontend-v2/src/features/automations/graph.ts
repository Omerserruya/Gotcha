import type { AutomationEdge, AutomationNode } from '@/api/contracts/automations';

/**
 * 09d's graph, pure: what each step offers as outputs, where a step can be
 * added, how the canvas lays it out, and the edits. The outputs mirror the
 * route's `outputsOf` (`automation-catalog.ts`) - the validator refuses a
 * connection from a branch the step does not have, so the canvas must offer
 * exactly the same ones.
 */

export const TRIGGER_NODE = 'automation_trigger';

/** Steps that end the automation's ownership: nothing follows them. */
export const TERMINAL = new Set(['hand_to_ai', 'run_skill', 'close_conversation']);

/** The messaging channels a channel split offers when it names none (`MESSAGING`). */
const MESSAGING = [
  'WHATSAPP',
  'MESSENGER',
  'INSTAGRAM',
  'EMAIL',
  'GMAIL',
  'OUTLOOK',
  'SLACK',
  'WEBCHAT',
  'SHOPIFY_LIVE_CHAT',
];

const FIXED: Readonly<Record<string, readonly string[]>> = {
  condition_group: ['true', 'false'],
  opening_hours: ['open', 'closed'],
  segment: ['new', 'returning', 'vip'],
  ab_split: ['a', 'b'],
};

export interface Graph {
  readonly nodes: readonly AutomationNode[];
  readonly edges: readonly AutomationEdge[];
}

const list = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);

/** The step right before this one (its first incoming edge's source). */
export function previousOf(id: string, graph: Graph): AutomationNode | null {
  const edge = graph.edges.find((e) => e.target === id);
  return edge ? (graph.nodes.find((n) => n.id === edge.source) ?? null) : null;
}

/** The outputs a step offers, in order. `next` is a plain step's one way on. */
export function outputsOf(node: AutomationNode, graph: Graph): readonly string[] {
  if (node.type === TRIGGER_NODE) return ['next'];
  if (TERMINAL.has(node.type)) return [];
  if (node.type === 'wait_for_reply') {
    const prev = previousOf(node.id, graph);
    const options =
      prev?.type === 'send_buttons'
        ? list(prev.data.buttons)
        : prev?.type === 'send_list'
          ? list(prev.data.options)
          : [];
    return [
      ...options.map((o) => `btn:${String((o as { id?: unknown })?.id ?? '')}`),
      'reply',
      'timeout',
    ];
  }
  if (node.type === 'split_channel') {
    const named = list(node.data.channels).filter((c): c is string => typeof c === 'string');
    return [...(named.length > 0 ? named : MESSAGING), 'other'];
  }
  if (node.type === 'language') {
    const langs = list(node.data.languages).filter((c): c is string => typeof c === 'string');
    return [...langs, 'other'];
  }
  return FIXED[node.type] ?? ['next'];
}

/** A branch is labelled on the canvas; a plain step's single `next` is not. */
export function isLabelled(handle: string | null): boolean {
  return handle !== null && handle !== 'next';
}

/** The edge leaving a step from one output - for a plain step, its single edge. */
export function edgeFrom(id: string, handle: string, graph: Graph): AutomationEdge | null {
  return (
    graph.edges.find(
      (e) =>
        e.source === id &&
        (handle === 'next'
          ? !e.sourceHandle || e.sourceHandle === 'next'
          : e.sourceHandle === handle),
    ) ?? null
  );
}

/** Outputs nothing is attached to yet - each is a "+" on the canvas. */
export function freeHandles(node: AutomationNode, graph: Graph): readonly string[] {
  return outputsOf(node, graph).filter((h) => edgeFrom(node.id, h, graph) === null);
}

/** What a new step starts with - enough for its inspector, not enough to go live. */
export function defaultData(type: string, newId: () => string): Record<string, unknown> {
  switch (type) {
    case 'send_message_text':
      return { text: '' };
    case 'send_buttons':
      return { text: '', buttons: [{ id: newId(), title: '' }] };
    case 'send_list':
      return { text: '', buttonText: '', options: [{ id: newId(), title: '' }] };
    case 'send_message_file':
      return { url: '', filename: '', caption: '' };
    case 'wait':
      return { durationMs: 60 * 60 * 1000 };
    case 'wait_for_reply':
      return { timeoutMs: 30 * 60 * 1000 };
    case 'ab_split':
      return { percentA: 50 };
    case 'language':
      return { languages: ['he', 'en'] };
    case 'assign':
      return { to: 'team' };
    case 'ai_generate':
      // Sends by default; the employee who writes it is the author's to choose.
      return { prompt: '', aiAgentId: '', send: true };
    case 'send_message_template':
      return { templateId: '', variables: {} };
    case 'send_comment_reply':
      return { mode: 'text', text: '' };
    default:
      return {};
  }
}

/** A new step after `after`, from one of its outputs. */
export function insertAfter(
  graph: Graph,
  after: string,
  handle: string,
  type: string,
  newId: () => string,
): { readonly graph: Graph; readonly id: string } {
  const id = newId();
  const node: AutomationNode = {
    id,
    type,
    position: { x: 0, y: 0 },
    data: defaultData(type, newId),
  };
  const edge: AutomationEdge = {
    id: newId(),
    source: after,
    target: id,
    sourceHandle: handle === 'next' ? null : handle,
  };
  return { graph: { nodes: [...graph.nodes, node], edges: [...graph.edges, edge] }, id };
}

/**
 * Remove a step. A plain step with one way on is spliced out (what came
 * before now leads to what came after); a branching or final one takes
 * everything only reachable through it - said before it happens.
 */
export function removeStep(graph: Graph, id: string): Graph {
  const node = graph.nodes.find((n) => n.id === id);
  if (!node || node.type === TRIGGER_NODE) return graph;
  const out = graph.edges.filter((e) => e.source === id);
  const into = graph.edges.filter((e) => e.target === id);
  if (outputsOf(node, graph).length === 1 && out.length === 1) {
    const next = out[0]!.target;
    return {
      nodes: graph.nodes.filter((n) => n.id !== id),
      edges: graph.edges
        .filter((e) => e.source !== id && e.target !== id)
        .concat(into.map((e) => ({ ...e, target: next }))),
    };
  }
  const gone = new Set(onlyThrough(graph, id));
  return {
    nodes: graph.nodes.filter((n) => !gone.has(n.id)),
    edges: graph.edges.filter((e) => !gone.has(e.source) && !gone.has(e.target)),
  };
}

/**
 * Remove several steps (09d's selection, Delete): each by `removeStep`'s own
 * rules, in turn - a step already gone with an earlier one is skipped, and
 * the trigger is never removed.
 */
export function removeSteps(graph: Graph, ids: readonly string[]): Graph {
  return ids.reduce(
    (now, id) => (now.nodes.some((n) => n.id === id) ? removeStep(now, id) : now),
    graph,
  );
}

/**
 * Duplicate a step that has one way on: the copy goes right after it, with
 * the same settings, and leads where the original led. A branching step
 * (which branch would the copy take?), a final one (nothing comes after it)
 * and the trigger are not duplicated - `null`.
 */
export function duplicateStep(
  graph: Graph,
  id: string,
  newId: () => string,
): { readonly graph: Graph; readonly id: string } | null {
  const node = graph.nodes.find((n) => n.id === id);
  if (!node || node.type === TRIGGER_NODE) return null;
  const outputs = outputsOf(node, graph);
  if (outputs.length !== 1 || outputs[0] !== 'next') return null;
  const copy: AutomationNode = {
    ...node,
    id: newId(),
    data: structuredClone(node.data),
  };
  return {
    id: copy.id,
    graph: {
      nodes: [...graph.nodes, copy],
      edges: [
        // What the original led to, the copy leads to now.
        ...graph.edges.map((e) => (e.source === id ? { ...e, source: copy.id } : e)),
        { id: newId(), source: id, target: copy.id, sourceHandle: null },
      ],
    },
  };
}

/** The step and everything reachable only through it. */
export function onlyThrough(graph: Graph, id: string): readonly string[] {
  const trigger = graph.nodes.find((n) => n.type === TRIGGER_NODE);
  const reach = (start: string | undefined, blocked: string | null) => {
    const seen = new Set<string>();
    const stack = start ? [start] : [];
    while (stack.length > 0) {
      const at = stack.pop()!;
      if (at === blocked || seen.has(at)) continue;
      seen.add(at);
      for (const e of graph.edges) if (e.source === at) stack.push(e.target);
    }
    return seen;
  };
  const without = reach(trigger?.id, id);
  return graph.nodes.map((n) => n.id).filter((n) => !without.has(n));
}

export const NODE_W = 260;
export const ROW_H = 168;
const GAP = 34;

export interface Placed {
  readonly x: number;
  readonly y: number;
}

/**
 * A tidy top-down layout: the trigger on top, each step under the one that
 * reaches it first, siblings side by side in output order, a parent centred
 * over its children. Positions stored on the nodes are not used - the
 * canvas draws the graph, not where someone once dragged it.
 */
export function layout(graph: Graph): {
  readonly at: ReadonlyMap<string, Placed>;
  readonly width: number;
  readonly height: number;
} {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const trigger = graph.nodes.find((n) => n.type === TRIGGER_NODE) ?? graph.nodes[0];
  const children = new Map<string, string[]>();
  const placed = new Set<string>();
  const order = (node: AutomationNode) => {
    const handles = outputsOf(node, graph);
    return graph.edges
      .filter((e) => e.source === node.id)
      .sort(
        (a, b) =>
          handles.indexOf(a.sourceHandle ?? 'next') - handles.indexOf(b.sourceHandle ?? 'next'),
      )
      .map((e) => e.target);
  };
  // The spanning tree, breadth first: a step joined twice sits under its first parent.
  const queue = trigger ? [trigger.id] : [];
  if (trigger) placed.add(trigger.id);
  while (queue.length > 0) {
    const id = queue.shift()!;
    const node = byId.get(id);
    if (!node) continue;
    const kids = order(node).filter((k) => byId.has(k) && !placed.has(k));
    kids.forEach((k) => placed.add(k));
    children.set(id, kids);
    queue.push(...kids);
  }
  // Steps nothing reaches still show - in a row of their own, at the bottom.
  const loose = graph.nodes.filter((n) => !placed.has(n.id)).map((n) => n.id);

  const at = new Map<string, Placed>();
  let slot = 0;
  let deepest = 0;
  const place = (id: string, depth: number): number => {
    deepest = Math.max(deepest, depth);
    const kids = children.get(id) ?? [];
    let x: number;
    if (kids.length === 0) {
      x = slot * (NODE_W + GAP);
      slot += 1;
    } else {
      const xs = kids.map((k) => place(k, depth + 1));
      x = (xs[0]! + xs[xs.length - 1]!) / 2;
    }
    at.set(id, { x, y: depth * ROW_H });
    return x;
  };
  if (trigger) place(trigger.id, 0);
  loose.forEach((id, i) => at.set(id, { x: i * (NODE_W + GAP), y: (deepest + 1) * ROW_H }));
  const columns = Math.max(slot, loose.length, 1);
  const rows = deepest + 1 + (loose.length > 0 ? 1 : 0);
  return { at, width: columns * (NODE_W + GAP) - GAP, height: rows * ROW_H };
}

/**
 * A file step's name. The executor reads `filename`; drafts saved before
 * 2026-10-14 wrote `fileName` (Backend accepts both) - read either, write
 * only `filename`.
 */
export function fileNameOf(data: Readonly<Record<string, unknown>>): string {
  const name = typeof data.filename === 'string' ? data.filename : data.fileName;
  return typeof name === 'string' ? name : '';
}
