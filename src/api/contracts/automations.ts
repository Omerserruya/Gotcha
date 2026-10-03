import { z } from 'zod';

/**
 * Automations — screen 09.
 *
 * Shapes read from `services/chatbot/src/routes/chatbot.ts` and the
 * `ChatbotFlow` model.
 *
 * ── A BARE ARRAY ──
 * `res.json(flows)` — no envelope at all. That is the **fourth** response
 * shape on this platform, after `{ data }`, `{ data, nextCursor }` and bare
 * `{ subscription }`, so this one is read with `raw` and parsed as an array.
 *
 * ── A COUNT, AND NO HISTORY ──
 * `runCount` is an `Int` described as *"number of times this flow has been
 * executed"*, and **there are no run-record models of any kind** — no
 * `FlowRun`, no `FlowExecution`, nothing. So:
 *
 *   - *"Ran 46 times **this week**"* is not derivable. The counter is
 *     cumulative and has no clock, so no per-period figure exists.
 *   - *"run history per rule with outcome and stop reason"* has a count and
 *     no history: the screen can say how many times, never which times or
 *     what happened.
 *   - **stop-reason clustering therefore has nothing to cluster**, which
 *     follows from the above rather than being a separate gap.
 *
 * ── WHAT ELSE IS NOT MODELLED ──
 * **`isActive` is a boolean.** No actor and no timestamp, so *"Paused by you
 * on 12 Aug"* cannot be said — only that it is paused.
 *
 * **`channel` is one channel or null, and null means all.** *"Runs on
 * WhatsApp, Instagram and email"* is not expressible: a flow covers exactly
 * one channel or every channel.
 *
 * **`₪12,400 recovered`** is attributed revenue — its **fifth** appearance
 * across five screens, and still with no inputs anywhere.
 */

export const automationSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable().default(null),
  isActive: z.boolean().default(false),
  /** `null` means every channel. One value means exactly that one. */
  channel: z.string().nullable().default(null),
  /** Free text describing the trigger — not a structured condition. */
  trigger: z.string().nullable().default(null),
  /**
   * Cumulative, for all time. **Never per-week**: the counter has no clock
   * and there are no run records to derive a period from.
   */
  runCount: z.number().default(0),
  updatedAt: z.string().nullable().default(null),
  /*
   * The flow graph (09's THEN). Only each node's TYPE and the edges are
   * named — node `data` carries message bodies and HTTP targets that no
   * card shows. `.catch`-ed: a graph this contract did not foresee must not
   * reject the list.
   */
  nodes: z
    .array(z.object({ id: z.string(), type: z.string().catch('') }))
    .catch([])
    .default([]),
  edges: z
    .array(z.object({ source: z.string(), target: z.string() }))
    .catch([])
    .default([]),
});

export type Automation = z.infer<typeof automationSchema>;

/** The node types the flow runner executes, read from its own switch. */
export const STEP_TYPES = [
  'send_message_text',
  'send_message_image',
  'send_message_file',
  'collect_input',
  'ai_generate',
  'http_request',
  'set_variable',
  'route_target',
] as const;

/**
 * 09's THEN: the flow's steps in the order it runs them — from the node no
 * edge leads into, along each node's one way out. Where a node has more than
 * one way out the flow BRANCHES, and the walk stops there and says so rather
 * than guessing which way is "the" case. A cycle stops the walk too.
 */
export function flowSteps(automation: Automation): {
  readonly steps: readonly string[];
  readonly branches: number;
} {
  const { nodes, edges } = automation;
  if (nodes.length === 0) return { steps: [], branches: 0 };
  const into = new Set(edges.map((edge) => edge.target));
  let current = nodes.find((node) => !into.has(node.id)) ?? nodes[0]!;
  const seen = new Set<string>();
  const steps: string[] = [];
  for (;;) {
    if (seen.has(current.id)) return { steps, branches: 0 };
    seen.add(current.id);
    steps.push(current.type);
    const out = edges.filter((edge) => edge.source === current.id);
    if (out.length !== 1) return { steps, branches: out.length > 1 ? out.length : 0 };
    const next = nodes.find((node) => node.id === out[0]!.target);
    if (!next) return { steps, branches: 0 };
    current = next;
  }
}

/** The route answers a bare array — no envelope. */
export const automationListSchema = z.array(automationSchema);

/**
 * Has this automation ever run?
 *
 * Separated from the count because zero and "never" read differently on a
 * screen about things that happen without anyone watching: an automation
 * that has never fired is worth noticing, and `0` buried in a row is not.
 */
export function hasEverRun(automation: Automation): boolean {
  return automation.runCount > 0;
}

/**
 * Where this automation applies, as a fact rather than a list.
 *
 * `null` means every channel. Returning `null` here rather than a synthetic
 * list of every known channel keeps the caller honest: the model says "all",
 * not "these eight", and enumerating them would invent a specificity the
 * flow does not have.
 */
export function appliesToChannel(automation: Automation): string | null {
  return automation.channel;
}
