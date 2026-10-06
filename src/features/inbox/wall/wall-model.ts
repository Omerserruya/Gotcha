import { copilotSentinel, isDraft, type Suggestion } from '@/api/contracts/copilot';
import { type OrderCard } from '@/api/contracts/customer-orders';

import type { CopilotRead } from '../load-copilot';
import type { WallHistory } from './load-wall';

/**
 * The Copilot wall's decisions, apart from its markup — so each one is tested
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
 * calls — over the conversations listed (the newest `HISTORY_LIMIT`), which
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
 * Refunds among this person's orders — or `null`, said as "—", when the orders
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
