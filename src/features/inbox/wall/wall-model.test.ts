import { describe, expect, it } from 'vitest';

import type { Suggestion, SuggestionsResponse } from '@/api/contracts/copilot';
import type { OrderCard } from '@/api/contracts/customer-orders';

import type { CopilotRead } from '../load-copilot';
import type { WallConversation, WallHistory } from './load-wall';
import {
  canUse,
  factLabel,
  firstOrder,
  ordersView,
  historyChannels,
  refundCount,
  saysRecommended,
  stepTo,
  suggestionView,
} from './wall-model';

const s = (over: Partial<Suggestion> = {}): Suggestion => ({
  id: 's1',
  text: 'Sorry about the wait.',
  confidence: 0.8,
  type: 'reply',
  ...over,
});

const ok = (over: Partial<SuggestionsResponse> = {}): CopilotRead =>
  ({
    state: 'ok',
    response: {
      data: [s()],
      copilotMode: 'READY_MESSAGE',
      stale: false,
      generating: false,
      basedOnMessageId: null,
      generatedAt: null,
      ...over,
    },
  }) satisfies CopilotRead;

describe('★★ suggestionView — every kind of nothing, said apart', () => {
  it('cards, and whether the customer wrote since', () => {
    expect(suggestionView(ok())).toMatchObject({ kind: 'cards', stale: false });
    expect(suggestionView(ok({ stale: true }))).toMatchObject({ kind: 'cards', stale: true });
  });

  it('★★ Backend 9c5e96cc: empty and generating is "writing", empty and stale is "waiting"', () => {
    expect(suggestionView(ok({ data: [], stale: true, generating: true }))).toEqual({
      kind: 'note',
      note: 'writing',
      retry: false,
    });
    expect(suggestionView(ok({ data: [], stale: true }))).toEqual({
      kind: 'note',
      note: 'waiting',
      retry: true,
    });
    // Not stale and empty: asked, answered, nothing — the ordinary empty case.
    expect(suggestionView(ok({ data: [] }))).toMatchObject({ note: 'none' });
  });

  it('★ the provider’s sentinels, each its own sentence; only a failure invites a retry', () => {
    const one = (id: string) => suggestionView(ok({ data: [s({ id })] }));
    expect(one('error')).toEqual({ kind: 'note', note: 'providerFailed', retry: true });
    expect(one('stub-1')).toMatchObject({ note: 'noProvider', retry: false });
    expect(one('disabled')).toMatchObject({ note: 'switchedOff', retry: false });
    expect(one('no-config')).toMatchObject({ note: 'noEmployee', retry: false });
    expect(one('no-match')).toMatchObject({ note: 'none' });
  });

  it('★ a refusal by its code — "not built" is never an upgrade', () => {
    const refused = (code: string) =>
      suggestionView({ state: 'refused', refusal: { code } as never });
    expect(refused('FEATURE_NOT_AVAILABLE')).toMatchObject({ note: 'notBuilt', retry: false });
    expect(refused('PLAN_LIMIT_REACHED')).toMatchObject({ note: 'limitReached' });
    expect(refused('FEATURE_NOT_ENTITLED')).toMatchObject({ note: 'notOnPlan' });
    expect(suggestionView({ state: 'unavailable' })).toMatchObject({ retry: true });
  });

  it('CHAT mode is another panel, not these cards', () => {
    expect(suggestionView(ok({ copilotMode: 'CHAT' }))).toMatchObject({ note: 'otherMode' });
  });
});

describe('canUse — a proposed action is never one click from the composer', () => {
  it('a reply with text, yes; an action or a blank, no', () => {
    expect(canUse(s())).toBe(true);
    expect(canUse(s({ type: 'quick_action' }))).toBe(false);
    expect(canUse(s({ text: '  ' }))).toBe(false);
  });
});

describe('stepTo — clamped, never wrapped', () => {
  it.each([
    [0, -1, 3, 0],
    [0, 1, 3, 1],
    [2, 1, 3, 2],
    [5, 0, 3, 2],
    [0, 1, 0, 0],
  ])('%i %+i of %i → %i', (index, delta, count, expected) => {
    expect(stepTo(index, delta, count)).toBe(expected);
  });
});

const conv = (channel: string, id = channel): WallConversation => ({
  id,
  channel,
  status: null,
  startedAt: null,
  lastAt: null,
  messages: 1,
  summary: null,
  isCurrent: false,
});

describe('historyChannels — names for written channels, a count for calls', () => {
  it('each written channel once, calls counted', () => {
    const history: WallHistory = {
      total: 24,
      hasMore: true,
      conversations: [
        conv('WHATSAPP', 'a'),
        conv('INSTAGRAM'),
        conv('WHATSAPP', 'b'),
        conv('VOICE', 'v1'),
        conv('EMAIL'),
      ],
    };
    expect(historyChannels(history)).toEqual({
      written: ['WHATSAPP', 'INSTAGRAM', 'EMAIL'],
      calls: 1,
    });
  });
});

const order = (over: Partial<OrderCard> = {}) =>
  ({ refund: null, refundedAmount: { amount: null, currency: null }, ...over }) as OrderCard;

describe('★ refundCount — "None" only when every order was read', () => {
  it('counts refund chips and refunded amounts', () => {
    const orders = [
      order(),
      order({ refund: { key: 'refunded', label: 'Refunded', tone: 'danger' } }),
      order({ refundedAmount: { amount: 10, currency: 'ILS' } }),
    ];
    expect(refundCount(orders, 3)).toBe(2);
  });

  it('★★ a page of orders is not all of them: null, said as "—"', () => {
    expect(refundCount([order()], 6)).toBeNull();
    expect(refundCount([order()], null)).toBeNull();
    expect(refundCount([order()], 1)).toBe(0);
  });
});

describe('firstOrder — the troubled one 04d would expand, else the newest', () => {
  it('its index, or 0', () => {
    const a = order();
    const b = order();
    expect(firstOrder([a, b], b)).toBe(1);
    expect(firstOrder([a, b], null)).toBe(0);
  });
});

describe('factLabel — a field key as words', () => {
  it.each([
    ['business_type', 'Business type'],
    ['preferred-size', 'Preferred size'],
    ['  city ', 'City'],
  ])('%s → %s', (key, label) => {
    expect(factLabel(key)).toBe(label);
  });
});

describe('saysRecommended', () => {
  it.each([
    ['Recommended · escalate', 'Recommended', true],
    ['recommended: escalate', 'Recommended', true],
    ['מומלץ · הסלמה', 'מומלץ', true],
    ['Recommended · escalate', 'מומלץ', true],
    ['escalate', 'Recommended', false],
  ])('%s (%s) → %s', (approach, word, expected) => {
    expect(saysRecommended(approach, word)).toBe(expected);
  });
});

describe('★★ ordersView — one source, never two', () => {
  const ctx = {
    state: 'ok',
    missing: [],
    summary: null,
    data: { recentOrders: [order()] },
  } as never;

  it('by contact when it was read — Woo, Shopify, or a reason', () => {
    expect(
      ordersView({ source: 'woocommerce', state: null, reason: null, orders: [] }, ctx),
    ).toMatchObject({
      source: 'woocommerce',
      orders: [],
    });
    expect(
      ordersView(
        { source: 'shopify', state: 'customer_not_linked', reason: null, orders: [] },
        ctx,
      ),
    ).toMatchObject({ source: 'shopify', state: 'customer_not_linked', orders: [] });
    expect(
      ordersView({ source: null, state: null, reason: 'store_not_chosen', orders: [] }, ctx),
    ).toMatchObject({ source: null, reason: 'store_not_chosen' });
  });

  it('★ no contact read (a visitor, a failure): the conversation’s own', () => {
    expect(ordersView(null, ctx)).toMatchObject({ source: 'shopify', state: 'ok', reason: null });
    expect(ordersView(null, ctx).orders).toHaveLength(1);
    expect(ordersView(null, null)).toMatchObject({ source: null, state: null, reason: null });
  });
});
