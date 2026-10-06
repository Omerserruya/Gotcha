import { describe, expect, it } from 'vitest';

import { notificationSchema } from '@/api/contracts/notifications';

import { groupOf, isKind, kindOf } from './notification-kind';

const n = (over: Record<string, unknown>) => notificationSchema.parse({ id: 'x', ...over });

describe('★ 01d - kinds from the catalogue’s keys, never guessed', () => {
  it.each([
    ['tool.approval_required', 'decision'],
    ['conversation.escalated', 'decision'],
    ['tool.action_failed', 'broken'],
    ['integration.check_failed', 'broken'],
    ['credit.auto_purchase_failed', 'broken'],
    ['broadcast.completed', null],
    ['lead.created', null],
    [undefined, null],
  ])('%s → %s', (eventType, kind) => {
    expect(kindOf(n({ eventType }))).toBe(kind);
  });

  it('only the two kinds are a filter', () => {
    expect(isKind('broken')).toBe(true);
    expect(isKind('everything')).toBe(false);
  });
});

describe('★ 01d - groups: the last hour, the rest of today, before', () => {
  const now = new Date(2026, 9, 3, 12, 0);
  it.each([
    [new Date(2026, 9, 3, 11, 58), 'now'],
    [new Date(2026, 9, 3, 11, 1), 'now'],
    [new Date(2026, 9, 3, 10, 59), 'today'],
    [new Date(2026, 9, 3, 0, 5), 'today'],
    [new Date(2026, 9, 2, 23, 59), 'earlier'],
  ])('%s → %s', (at, group) => {
    expect(groupOf(n({ createdAt: at.toISOString() }), now)).toBe(group);
  });

  it('no time is "earlier", not "now"', () => {
    expect(groupOf(n({}), now)).toBe('earlier');
  });
});
