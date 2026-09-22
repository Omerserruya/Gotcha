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
});

export type Automation = z.infer<typeof automationSchema>;

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
