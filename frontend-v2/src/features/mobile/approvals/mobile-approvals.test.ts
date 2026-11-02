import { describe, expect, it } from 'vitest';

import { approvalSchema } from '@/api/contracts/approvals';

import {
  amountOf,
  decidedOn,
  decidedOutcome,
  isUrgent,
  planAsked,
  requestersOf,
  rowClock,
  spanOf,
  tagTone,
} from './mobile-approvals';

const NOW = new Date('2026-11-02T12:00:00.000Z');
const row = (over: Record<string, unknown> = {}) =>
  approvalSchema.parse({
    id: 'a1',
    tool: 'shopify.process_refund',
    summary: 'Refund order #1001',
    status: 'PENDING',
    expiresAt: '2026-11-03T12:00:00.000Z',
    createdAt: '2026-11-02T10:00:00.000Z',
    ...over,
  });

describe('★★ a card says lapsed, time left, or time waited', () => {
  it('past its deadline while still PENDING is lapsed - never a decision on offer', () => {
    expect(rowClock(row({ expiresAt: '2026-11-02T11:59:00.000Z' }), NOW)).toEqual({
      kind: 'lapsed',
    });
  });

  it('an EXPIRED row is lapsed too', () => {
    expect(rowClock(row({ status: 'EXPIRED' }), NOW)).toEqual({ kind: 'lapsed' });
  });

  it('within the hour: how long is left', () => {
    expect(rowClock(row({ expiresAt: '2026-11-02T12:38:00.000Z' }), NOW)).toEqual({
      kind: 'left',
      ms: 38 * 60_000,
    });
  });

  it('otherwise: how long it has waited', () => {
    expect(rowClock(row(), NOW)).toEqual({ kind: 'waited', ms: 2 * 3_600_000 });
  });
});

describe('spans as the desktop’s time keys', () => {
  it('minutes, hours under two days, then days', () => {
    expect(spanOf(4 * 60_000)).toEqual({ unit: 'minutes', n: 4 });
    expect(spanOf(5 * 3_600_000)).toEqual({ unit: 'hours', n: 5 });
    expect(spanOf(72 * 3_600_000)).toEqual({ unit: 'days', n: 3 });
    expect(spanOf(-5)).toEqual({ unit: 'minutes', n: 0 });
  });
});

describe('★ who asked - the desktop page’s rule', () => {
  const pending = [
    row({ id: 'named', requestedBy: 'user:u1' }),
    row({ id: 'bot', requestedBy: 'ai-bot:x' }),
    row({ id: 'flow', requestedBy: 'flow:f1' }),
  ];
  const nameOf = (a: { id: string }) => (a.id === 'named' ? 'Dana' : null);

  it('one live AI employee names the AI’s request', () => {
    expect(requestersOf(pending, nameOf, ['Support AI'])).toEqual({
      names: { named: 'Dana', bot: 'Support AI' },
      aiAsked: [],
    });
  });

  it('several, or none: "your AI employee", never a guessed name; a flow stays unnamed', () => {
    expect(requestersOf(pending, nameOf, ['A', 'B'])).toEqual({
      names: { named: 'Dana' },
      aiAsked: ['bot'],
    });
  });
});

describe('a plan says who asked, and where', () => {
  const plan = (requester: unknown, source: unknown = 'home_assistant') =>
    row({ tool: 'propose_plan', params: { source, requester, steps: [] } });

  it('you, someone named, or someone', () => {
    expect(planAsked(plan({ userId: 'me', name: 'Omer' }), 'me')).toEqual({
      key: 'plan.asked.you.home_assistant',
    });
    expect(planAsked(plan({ userId: 'u2', name: 'Matan' }), 'me')).toEqual({
      key: 'plan.asked.other.home_assistant',
      name: 'Matan',
    });
    expect(planAsked(plan(null, null), null)).toEqual({ key: 'plan.asked.someone.unknown' });
  });

  it('nothing for a request that is not a plan', () => {
    expect(planAsked(row(), 'me')).toBeNull();
  });
});

describe('an amount only as the call stated it', () => {
  it('in its currency when named; a bare number otherwise; nothing without one', () => {
    expect(amountOf(row({ params: { amount: 179, currency: 'ILS' } }), 'en')).toMatch(/179/);
    expect(amountOf(row({ params: { amount: 179, currency: 'ILS' } }), 'en')).toMatch(/₪|ILS/);
    expect(amountOf(row({ params: { amount: 179 } }), 'en')).toBe('179');
    expect(amountOf(row(), 'en')).toBeNull();
  });
});

describe('a card’s one tag and its tone', () => {
  it('danger, money, the AI’s own, and every other tag quiet', () => {
    expect(tagTone('IRREVERSIBLE')).toBe('bad');
    expect(tagTone('HIGH')).toBe('bad');
    expect(tagTone('FINANCIAL')).toBe('warn');
    expect(tagTone('PLAN')).toBe('ai');
    expect(tagTone('cancel_order')).toBe('mute');
  });

  it('the time is urgent inside the hour and past the deadline, not while it waits', () => {
    expect(isUrgent({ kind: 'left', ms: 1 })).toBe(true);
    expect(isUrgent({ kind: 'lapsed' })).toBe(true);
    expect(isUrgent({ kind: 'waited', ms: 1 })).toBe(false);
  });
});

describe('★ decided today, and what each decision came to', () => {
  it('only rows decided on today’s date; an undated decision is not today’s', () => {
    const today = row({ id: 't', status: 'APPROVED', decidedAt: '2026-11-02T09:00:00.000Z' });
    const before = row({ id: 'y', status: 'APPROVED', decidedAt: '2026-10-30T09:00:00.000Z' });
    const undated = row({ id: 'u', status: 'REJECTED' });
    expect(decidedOn([today, before, undated], NOW).map((a) => a.id)).toEqual(['t']);
  });

  it('rejected; approved and ran; approved and did not run; approved, run not known', () => {
    expect(decidedOutcome(row({ status: 'REJECTED' }))).toBe('rejected');
    expect(decidedOutcome(row({ status: 'APPROVED', executionState: 'SUCCEEDED' }))).toBe('ran');
    expect(decidedOutcome(row({ status: 'APPROVED', executionState: 'FAILED' }))).toBe('didntRun');
    expect(decidedOutcome(row({ status: 'APPROVED', executionState: 'LEGACY_UNVERIFIED' }))).toBe(
      'approved',
    );
  });
});
