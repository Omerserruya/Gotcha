import type { ActivityStatus, ActivityStep } from '@/api/contracts/ai-activity';
import { copilotSentinel, isDraft, type Suggestion } from '@/api/contracts/copilot';
import {
  ordersIn,
  type CommerceContextResponse,
  type CommerceState,
  type CustomerOrders,
  type MatchedOrderCard,
  type OrderCard,
} from '@/api/contracts/customer-orders';

import type { CopilotRead } from '../load-copilot';
import type { WallHistory } from './load-wall';

/**
 * The Copilot wall's decisions, apart from its markup - so each one is tested
 * as a rule rather than as a count of elements.
 */

/** Every way the suggestions read can come back, as the carousel draws it. */
export type SuggestionView =
  | {
      readonly kind: 'cards';
      readonly suggestions: readonly Suggestion[];
      /** The customer wrote since these were made; new ones are on the way. */
      readonly stale: boolean;
    }
  | {
      readonly kind: 'note';
      /** A key under `inbox.copilot`. */
      readonly note:
        | 'unavailable'
        | 'notBuilt'
        | 'limitReached'
        | 'notOnPlan'
        | 'otherMode'
        | 'providerFailed'
        | 'noProvider'
        | 'switchedOff'
        | 'noEmployee'
        | 'none'
        /** Nothing stored, and a customer message waits: they come when it is answered. */
        | 'waiting'
        /** …and a generation is running now: the event follows. */
        | 'writing';
      /** Only where asking again could change the answer. */
      readonly retry: boolean;
    };

/**
 * The same four kinds of nothing the old panel drew (`CopilotPanel`, now
 * folded in here), plus the five sentinels the provider sends as a 200.
 */
export function suggestionView(read: CopilotRead): SuggestionView {
  if (read.state === 'unavailable') return { kind: 'note', note: 'unavailable', retry: true };
  if (read.state === 'refused') {
    const { code } = read.refusal;
    return {
      kind: 'note',
      note:
        code === 'FEATURE_NOT_AVAILABLE'
          ? 'notBuilt'
          : code === 'PLAN_LIMIT_REACHED'
            ? 'limitReached'
            : 'notOnPlan',
      retry: false,
    };
  }
  const { data: suggestions, copilotMode, stale, generating } = read.response;
  if (copilotMode.trim().toUpperCase() !== 'READY_MESSAGE') {
    return { kind: 'note', note: 'otherMode', retry: false };
  }
  const sentinel = copilotSentinel(suggestions);
  if (sentinel === 'provider_failed') return { kind: 'note', note: 'providerFailed', retry: true };
  if (sentinel === 'no_provider') return { kind: 'note', note: 'noProvider', retry: false };
  if (sentinel === 'switched_off') return { kind: 'note', note: 'switchedOff', retry: false };
  if (sentinel === 'no_employee') return { kind: 'note', note: 'noEmployee', retry: false };
  if (suggestions.length === 0 && generating)
    return { kind: 'note', note: 'writing', retry: false };
  if (suggestions.length === 0 && stale) return { kind: 'note', note: 'waiting', retry: true };
  if (sentinel === 'nothing_relevant' || suggestions.length === 0) {
    return { kind: 'note', note: 'none', retry: true };
  }
  return { kind: 'cards', suggestions, stale };
}

/** "Use this" and "Edit" only on a reply: a proposed action is never one click from anywhere. */
export const canUse = (suggestion: Suggestion): boolean =>
  isDraft(suggestion) && suggestion.text.trim() !== '';

/**
 * A step through a carousel. Clamped, not wrapped: 02 greys ‹ on the first,
 * and a wrap from the last order to the first reads as "there are no more"
 * being false.
 */
export function stepTo(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, index + delta));
}

/**
 * The history row's second line: names for written channels, a count for
 * calls - over the conversations listed (the newest `HISTORY_LIMIT`), which
 * is what the route sends; `total` is the whole count.
 */
export function historyChannels(history: WallHistory): {
  readonly written: readonly string[];
  readonly calls: number;
} {
  const calls = history.conversations.filter((c) => c.channel === 'VOICE').length;
  const written = [
    ...new Set(history.conversations.map((c) => c.channel).filter((c) => c !== 'VOICE')),
  ];
  return { written, calls };
}

/**
 * Refunds among this person's orders - or `null`, said as "-", when the orders
 * read are not all of them. `recentOrders` is a page, and a count over a page
 * would say "None" about somebody refunded in an order we did not read.
 */
export function refundCount(
  orders: readonly OrderCard[],
  orderCount: number | null,
): number | null {
  if (orderCount === null || orders.length < orderCount) return null;
  return orders.filter((o) => o.refund !== null || (o.refundedAmount.amount ?? 0) > 0).length;
}

/** The order the carousel opens on: the troubled one 04d would expand, else the newest. */
export function firstOrder(orders: readonly OrderCard[], expand: OrderCard | null): number {
  if (!expand) return 0;
  return Math.max(0, orders.indexOf(expand));
}

/**
 * A fact's field key as a label: `business_type` → "Business type". The keys
 * are the tenant's own fields, an open set, so no catalogue can hold them.
 */
export function factLabel(key: string): string {
  const words = key.trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Does the model's own approach already lead with "Recommended"? Checked in
 * English and in the reader's word, case-insensitively, so the label is
 * never "Recommended · Recommended · escalate".
 */
export function saysRecommended(approach: string, word: string): boolean {
  const head = approach.trim().toLocaleLowerCase();
  return [word, 'recommended'].some(
    (w) => w.trim() && head.startsWith(w.trim().toLocaleLowerCase()),
  );
}

/** One `ai.activity.updated`, as the wall needs it. */
export interface StepChange {
  readonly stepId: string;
  readonly tool: string;
  readonly labelKey: string;
  readonly status: ActivityStatus | null;
  readonly ts: string | null;
}

const ENDED: readonly (ActivityStatus | null)[] = ['completed', 'failed', 'denied'];

/**
 * A step changed: that row updated in place, or a new one at the top (newest
 * first, as the route sends them). Times come from the event's own `ts`, so
 * "running → completed" gets its duration without re-reading the list.
 */
export function applyStep(steps: readonly ActivityStep[], change: StepChange): ActivityStep[] {
  const at = change.ts;
  const existing = steps.find((s) => s.id === change.stepId);
  const base: ActivityStep = existing ?? {
    id: change.stepId,
    tool: change.tool,
    labelKey: change.labelKey,
    status: null,
    proposedAt: at,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    error: null,
  };
  const startedAt = change.status === 'running' ? (base.startedAt ?? at) : base.startedAt;
  const completedAt = ENDED.includes(change.status) ? (base.completedAt ?? at) : base.completedAt;
  const durationMs =
    base.durationMs ??
    (startedAt && completedAt
      ? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)) || null
      : null);
  const next: ActivityStep = {
    ...base,
    tool: change.tool || base.tool,
    labelKey: change.labelKey || base.labelKey,
    status: change.status ?? base.status,
    startedAt,
    completedAt,
    durationMs: Number.isNaN(durationMs) ? null : durationMs,
  };
  return existing ? steps.map((s) => (s.id === next.id ? next : s)) : [next, ...steps];
}

/** "N steps · Xs", and whether anything is running now. */
export function activitySummary(steps: readonly ActivityStep[]): {
  readonly count: number;
  readonly totalMs: number;
  readonly running: boolean;
} {
  return {
    count: steps.length,
    totalMs: steps.reduce((sum, s) => sum + (s.durationMs ?? 0), 0),
    running: steps.some((s) => s.status === 'running'),
  };
}

/** What the order carousel is given: one source, chosen. */
export interface OrdersView {
  readonly source: string | null;
  readonly state: CommerceState | null;
  readonly reason: string | null;
  readonly missing: readonly string[];
  readonly orders: readonly (OrderCard & { readonly matchedBy?: MatchedOrderCard['matchedBy'] })[];
}

/**
 * The person's orders by contact when that was read (Woo or Shopify, one
 * shape); otherwise the conversation's own commerce context - a visitor, or a
 * failed contact read. Never both: two answers about money on one screen.
 */
export function ordersView(
  byContact: CustomerOrders | null,
  conversation: CommerceContextResponse | null,
): OrdersView {
  if (byContact) {
    return {
      source: byContact.source,
      state: byContact.source === 'shopify' ? byContact.state : null,
      reason: byContact.source === null ? (byContact.reason ?? 'unknown') : null,
      missing: [],
      orders: byContact.orders,
    };
  }
  return {
    source: conversation ? 'shopify' : null,
    state: conversation?.state ?? null,
    reason: null,
    missing: conversation?.missing ?? [],
    orders: ordersIn(conversation),
  };
}
