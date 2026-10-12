import { describe, expect, it } from 'vitest';

import { conversationRowSchema } from '@/api/contracts/inbox';

import { slaState, slaTargetFor, type SlaClock } from './sla-clock';

/**
 * W2 (Omer, 2026-10-12): the legacy inbox's response target, ported. Which
 * rows are timed, by which target, from when - and where each one stands.
 */
const clock = (over: Partial<SlaClock> = {}): SlaClock => ({
  minutes: 30,
  warningPercent: 70,
  departments: {},
  ...over,
});
const row = (over: Record<string, unknown> = {}) =>
  conversationRowSchema.parse({
    id: 'c1',
    status: 'OPEN',
    handledBy: 'human',
    lastMessageDirection: 'INBOUND',
    lastMessageAt: '2026-10-12T10:00:00.000Z',
    createdAt: '2026-10-12T09:00:00.000Z',
    ...over,
  });
const at = (iso: string) => Date.parse(iso);

describe('★★ who is timed: a customer waiting on us', () => {
  it('an open conversation a person holds, the customer last to speak', () => {
    expect(slaTargetFor(row(), clock())).toEqual({
      since: '2026-10-12T10:00:00.000Z',
      minutes: 30,
      warningPercent: 70,
    });
  });

  it('★★ never a conversation GOTCHA or a flow is carrying (as legacy)', () => {
    expect(slaTargetFor(row({ handledBy: 'ai_agent' }), clock())).toBeNull();
    expect(slaTargetFor(row({ handledBy: 'flow' }), clock())).toBeNull();
    // Unrouted is nobody's yet - a person owes it an answer.
    expect(slaTargetFor(row({ handledBy: null }), clock())).not.toBeNull();
  });

  it('★★ never one whose last message was ours (supervisor, 2026-10-12)', () => {
    expect(slaTargetFor(row({ lastMessageDirection: 'OUTBOUND' }), clock())).toBeNull();
  });

  it('never a closed one; WAITING is still timed', () => {
    expect(slaTargetFor(row({ status: 'CLOSED' }), clock())).toBeNull();
    expect(slaTargetFor(row({ status: 'WAITING' }), clock())).not.toBeNull();
  });

  it('★★ no target known (a 403, a failed read, switched off): nobody is timed', () => {
    expect(slaTargetFor(row(), null)).toBeNull();
  });

  it('from the last message, else when it started; neither - not timed', () => {
    expect(slaTargetFor(row({ lastMessageAt: null }), clock())?.since).toBe(
      '2026-10-12T09:00:00.000Z',
    );
    expect(slaTargetFor(row({ lastMessageAt: null, createdAt: null }), clock())).toBeNull();
    expect(slaTargetFor(row({ lastMessageAt: 'soon', createdAt: null }), clock())).toBeNull();
  });
});

describe('★★ by which target: the department’s own, else the workspace’s', () => {
  it('a department with its own minutes', () => {
    const own = clock({ departments: { d1: 10, d2: 'workspace' } });
    expect(slaTargetFor(row({ departmentId: 'd1' }), own)?.minutes).toBe(10);
    expect(slaTargetFor(row({ departmentId: 'd2' }), own)?.minutes).toBe(30);
    expect(slaTargetFor(row({ departmentId: null }), own)?.minutes).toBe(30);
  });

  it('★ a department whose own target could not be read: not timed - never the other target', () => {
    expect(
      slaTargetFor(row({ departmentId: 'd1' }), clock({ departments: { d1: 'unread' } })),
    ).toBeNull();
  });
});

describe('★★ where it stands', () => {
  const target = { since: '2026-10-12T10:00:00.000Z', minutes: 30, warningPercent: 70 };

  it('under the warning: nothing', () => {
    expect(slaState(target, at('2026-10-12T10:20:00.000Z'))).toEqual({ kind: 'none' });
  });

  it('★ at the warning: amber, the minutes left (rounded up, never 0)', () => {
    expect(slaState(target, at('2026-10-12T10:21:00.000Z'))).toEqual({
      kind: 'warning',
      minutesLeft: 9,
    });
    expect(slaState(target, at('2026-10-12T10:29:30.000Z'))).toEqual({
      kind: 'warning',
      minutesLeft: 1,
    });
  });

  it('★★ at the target and past it: late', () => {
    expect(slaState(target, at('2026-10-12T10:30:00.000Z'))).toEqual({ kind: 'late' });
    expect(slaState(target, at('2026-10-13T10:30:00.000Z'))).toEqual({ kind: 'late' });
  });

  it('no warning set: only late', () => {
    const late = { ...target, warningPercent: null };
    expect(slaState(late, at('2026-10-12T10:29:00.000Z'))).toEqual({ kind: 'none' });
    expect(slaState(late, at('2026-10-12T10:31:00.000Z'))).toEqual({ kind: 'late' });
  });
});

describe('★★ from when the customer started waiting (Backend 558f64a5)', () => {
  it('★★ waitingSince wins over the last message - three messages do not restart the clock', () => {
    const target = slaTargetFor(
      row({ waitingSince: '2026-10-12T09:40:00.000Z', lastMessageAt: '2026-10-12T10:00:00.000Z' }),
      clock(),
    );
    expect(target?.since).toBe('2026-10-12T09:40:00.000Z');
  });

  it('★★ null is an answer: nothing came in after our reply - no mark, whatever else the row says', () => {
    expect(
      slaTargetFor(row({ waitingSince: null, lastMessageDirection: 'INBOUND' }), clock()),
    ).toBeNull();
  });

  it('★ absent (a server from before it): the older rule, from the last message', () => {
    const parsed = row();
    expect(parsed.waitingSince).toBeUndefined();
    expect(slaTargetFor(parsed, clock())?.since).toBe('2026-10-12T10:00:00.000Z');
    expect(slaTargetFor(row({ lastMessageDirection: 'OUTBOUND' }), clock())).toBeNull();
  });

  it('a value that is not a string reads as null - no mark, never the older rule', () => {
    const parsed = row({ waitingSince: 42 });
    expect(parsed.waitingSince).toBeNull();
    expect(slaTargetFor(parsed, clock())).toBeNull();
  });
});
