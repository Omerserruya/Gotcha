import { describe, expect, it } from 'vitest';

import {
  deliversNothing,
  shadowedRuleIds,
  undeliverableChannels,
  type NotificationRule,
} from '@/api/contracts/notification-rules';
import type { Department, Member } from '@/api/contracts/people';

import { NOTIFIABLE_EVENTS, UNFIRING_EVENTS } from './events';
import { eventStatus, groupRulesByEvent, toRuleView } from './rule-view';

/**
 * This tenant has no notification rules at all, so no capture can exercise any
 * of this. These tests are the only place the list's judgements are checked -
 * which of them is why they assert consequences (nobody is told) rather than
 * shapes.
 */

const rule = (over: Partial<NotificationRule> = {}): NotificationRule => ({
  id: 'r1',
  departmentId: null,
  eventType: 'payment.failed',
  enabled: true,
  channels: ['email', 'in_app'],
  recipients: { type: 'tenant_owner' },
  priority: 'MEDIUM',
  conditions: null,
  ...over,
});

const context = (over: Partial<Parameters<typeof toRuleView>[1]> = {}) => ({
  departments: [] as readonly Department[] | null,
  members: [] as readonly Member[] | null,
  shadowed: new Set<string>(),
  ...over,
});

describe('eventStatus', () => {
  it('separates "nothing raises it" from "no such event"', () => {
    expect(eventStatus('payment.failed')).toBe('known');
    expect(eventStatus('system.error.critical')).toBe('unfiring');
    expect(eventStatus('conversaton.escalated')).toBe('unknown');
  });

  it('classifies every event in the vocabulary, and every one excluded from it', () => {
    for (const event of NOTIFIABLE_EVENTS) expect(eventStatus(event.type)).toBe('known');
    for (const type of UNFIRING_EVENTS) expect(eventStatus(type)).toBe('unfiring');
  });

  it('calls a typo unknown rather than guessing at the nearest event', () => {
    // The route validates eventType against nothing, so this is a 201 and it
    // reads as enabled forever. Correcting it silently would be worse than
    // showing it: the stored row would still never match.
    expect(eventStatus('payment.faield')).toBe('unknown');
    expect(eventStatus('')).toBe('unknown');
  });
});

describe('channels the route accepts and the dispatcher drops', () => {
  it('names slack, sms and webhook as undeliverable', () => {
    expect(undeliverableChannels(rule({ channels: ['email', 'slack'] }))).toEqual(['slack']);
    expect(undeliverableChannels(rule({ channels: ['sms', 'webhook'] }))).toEqual([
      'sms',
      'webhook',
    ]);
  });

  it('leaves the two real channels alone', () => {
    expect(undeliverableChannels(rule({ channels: ['email', 'in_app'] }))).toEqual([]);
  });

  it('tells a rule that delivers nothing from one that delivers less', () => {
    expect(deliversNothing(rule({ channels: ['slack'] }))).toBe(true);
    expect(deliversNothing(rule({ channels: ['slack', 'email'] }))).toBe(false);
    // No channels at all is a different problem and not this one.
    expect(deliversNothing(rule({ channels: [] }))).toBe(false);
  });
});

describe('shadowedRuleIds', () => {
  it('marks the tenant-wide rule a department rule displaces', () => {
    // engine:138 filters the tenant-wide rows OUT when a department row
    // matches. It does not merge them, so the owner is told nothing about
    // that department's failures while both rows read as enabled.
    const wide = rule({ id: 'wide', departmentId: null });
    const dept = rule({ id: 'dept', departmentId: 'd1' });
    expect([...shadowedRuleIds([wide, dept])]).toEqual(['wide']);
  });

  it('only displaces within the same event', () => {
    const wide = rule({ id: 'wide', eventType: 'payment.failed' });
    const dept = rule({ id: 'dept', eventType: 'invoice.paid', departmentId: 'd1' });
    expect([...shadowedRuleIds([wide, dept])]).toEqual([]);
  });

  it('a disabled department rule displaces nothing', () => {
    // The engine's own query is `enabled: true`, so a switched-off department
    // rule never enters the comparison that drops the tenant-wide one.
    const wide = rule({ id: 'wide' });
    const dept = rule({ id: 'dept', departmentId: 'd1', enabled: false });
    expect([...shadowedRuleIds([wide, dept])]).toEqual([]);
  });

  it('never marks a department rule as shadowed', () => {
    const a = rule({ id: 'a', departmentId: 'd1' });
    const b = rule({ id: 'b', departmentId: 'd2' });
    expect([...shadowedRuleIds([a, b])]).toEqual([]);
  });
});

describe('toRuleView', () => {
  it('names the team a rule is scoped to', () => {
    const view = toRuleView(
      rule({ departmentId: 'd1' }),
      context({ departments: [{ id: 'd1', name: 'Sales', isActive: true }] as Department[] }),
    );
    expect(view.departmentName).toBe('Sales');
    expect(view.departmentMissing).toBe(false);
  });

  it('does not draw an unnameable team as tenant-wide', () => {
    // Overstating a rule's reach is the worse of the two errors: "every team"
    // and "one team we cannot name" are opposite facts.
    const view = toRuleView(rule({ departmentId: 'gone' }), context({ departments: [] }));
    expect(view.departmentMissing).toBe(true);
    expect(view.departmentId).toBe('gone');
  });

  it('names people rather than showing their ids', () => {
    const view = toRuleView(
      rule({ recipients: { type: 'users', userIds: ['u1', 'u2'] } }),
      context({
        members: [
          { id: 'u1', name: 'Maya Levi', isActive: true, departments: [] },
          { id: 'u2', name: null, email: 'tomer@example.com', isActive: true, departments: [] },
        ] as Member[],
      }),
    );
    expect(view.recipientNames).toEqual(['Maya Levi', 'tomer@example.com']);
    expect(view.unresolvedRecipients).toBe(0);
  });

  it('counts recipients who no longer have an account instead of dropping them silently', () => {
    const view = toRuleView(
      rule({ recipients: { type: 'users', userIds: ['u1', 'ghost'] } }),
      context({
        members: [{ id: 'u1', name: 'Maya Levi', isActive: true, departments: [] }] as Member[],
      }),
    );
    expect(view.recipientNames).toEqual(['Maya Levi']);
    expect(view.unresolvedRecipients).toBe(1);
  });

  it('shows a string condition as written, because nothing parses it', () => {
    const view = toRuleView(rule({ conditions: 'amount > 500' }), context());
    expect(view.conditions).toEqual(['amount > 500']);
  });

  it('flattens structured conditions to readable clauses', () => {
    const view = toRuleView(
      rule({ conditions: [{ field: 'amount', op: 'gt', value: 500 }] }),
      context(),
    );
    expect(view.conditions).toEqual(['amount gt 500']);
  });
});

describe('groupRulesByEvent', () => {
  const ctx = { departments: [] as Department[], members: [] as Member[] };

  it('keeps every rule on an event rather than choosing one', () => {
    // The uniqueness indexes were dropped so one event can route to different
    // people on different channels, and ALL of them apply. A grid would have
    // to pick one of these two and would misdescribe the configuration.
    const groups = groupRulesByEvent(
      [
        rule({ id: 'a', recipients: { type: 'tenant_owner' } }),
        rule({ id: 'b', recipients: { type: 'users', userIds: ['u1'] }, channels: ['in_app'] }),
      ],
      ctx,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rules.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('orders by the vocabulary, so the list reads like the day-one state', () => {
    const groups = groupRulesByEvent(
      [
        rule({ id: 'a', eventType: 'subscription.canceled' }),
        rule({ id: 'b', eventType: 'tool.approval_required' }),
      ],
      ctx,
    );
    expect(groups.map((g) => g.eventType)).toEqual([
      'tool.approval_required',
      'subscription.canceled',
    ]);
  });

  it('sorts broken events last, where the attention belongs', () => {
    const groups = groupRulesByEvent(
      [
        rule({ id: 'a', eventType: 'conversaton.escalated' }),
        rule({ id: 'b', eventType: 'payment.failed' }),
      ],
      ctx,
    );
    expect(groups.map((g) => g.status)).toEqual(['known', 'unknown']);
  });

  it('carries the shadowing across the grouping', () => {
    const groups = groupRulesByEvent(
      [rule({ id: 'wide' }), rule({ id: 'dept', departmentId: 'd1' })],
      ctx,
    );
    const views = groups[0]!.rules;
    expect(views.find((v) => v.id === 'wide')!.shadowed).toBe(true);
    expect(views.find((v) => v.id === 'dept')!.shadowed).toBe(false);
  });
});
