import { describe, expect, it } from 'vitest';

import {
  botIdleBody,
  botIdleGroupProblem,
  botIdleGroupsOf,
  type BotIdleGroupWrite,
} from './bot-idle-automation';

/**
 * ★★ The AI employee's follow-up, per group (assumed shape, Supervisior
 * 2026-11-19): read whole or not at all, one group never costs the other,
 * and the write sends only the groups given.
 */
const group = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  reminderAfterMinutes: 10,
  closeAfterReminderMinutes: 10,
  reminderText: 'Still here? You can pick this up any time.',
  closeText: 'We’ve closed this chat for now.',
  source: 'default',
  ...over,
});

describe('★★ the read: each group whole, or unread', () => {
  it('reads both groups as the server sends them, its source included', () => {
    const got = botIdleGroupsOf({
      liveChat: group(),
      messaging: group({
        reminderAfterMinutes: 30,
        closeAfterReminderMinutes: 15,
        source: 'custom',
      }),
    });
    expect(got.liveChat).toEqual({ ...group(), source: 'default' });
    expect(got.messaging).toMatchObject({
      reminderAfterMinutes: 30,
      closeAfterReminderMinutes: 15,
      source: 'custom',
    });
  });

  it.each([
    ['a missing delay', { reminderAfterMinutes: undefined }],
    ['a delay of 0', { closeAfterReminderMinutes: 0 }],
    ['a fractional delay', { reminderAfterMinutes: 1.5 }],
    ['over seven days', { reminderAfterMinutes: 10081 }],
    ['no enabled', { enabled: undefined }],
  ])('★ %s: that group is unread - no number of ours fills it in', (_, over) => {
    const got = botIdleGroupsOf({ liveChat: group(over), messaging: group() });
    expect(got.liveChat).toBeNull();
    expect(got.messaging).not.toBeNull();
  });

  it('a missing or odd source draws no hint; null texts read as empty', () => {
    const got = botIdleGroupsOf({
      liveChat: group({ source: 'tenant' }),
      messaging: group({ source: undefined, closeText: null }),
    });
    expect(got.liveChat!.source).toBeNull();
    expect(got.messaging!.source).toBeNull();
    expect(got.messaging!.closeText).toBe('');
  });

  it.each([null, 'x', [], {}])('★ %j (the flat route of today included) reads no group', (raw) => {
    expect(botIdleGroupsOf(raw)).toEqual({ liveChat: null, messaging: null });
  });

  it('today’s flat object reads no group, so nothing is offered to save', () => {
    const flat = {
      reminderEnabled: true,
      reminderDelayMinutes: 10,
      reminderMessage: 'x',
      autoCloseEnabled: true,
      autoCloseDelayMinutes: 20,
      autoCloseMessage: '',
      channels: ['WEBCHAT'],
    };
    expect(botIdleGroupsOf(flat)).toEqual({ liveChat: null, messaging: null });
  });
});

const write = (over: Partial<BotIdleGroupWrite> = {}): BotIdleGroupWrite => ({
  enabled: true,
  reminderAfterMinutes: 30,
  closeAfterReminderMinutes: 15,
  reminderText: ' Still here? ',
  closeText: ' Closed. ',
  ...over,
});

describe('★★ the write: only the groups given, each whole', () => {
  it('★ one group: only it, its texts trimmed, never its source', () => {
    expect(botIdleBody({ messaging: write() })).toEqual({
      messaging: {
        enabled: true,
        reminderAfterMinutes: 30,
        closeAfterReminderMinutes: 15,
        reminderText: 'Still here?',
        closeText: 'Closed.',
      },
    });
  });

  it('both, when both are given', () => {
    expect(Object.keys(botIdleBody({ liveChat: write(), messaging: write() }))).toEqual([
      'liveChat',
      'messaging',
    ]);
  });

  it.each([
    [{ reminderAfterMinutes: 0 }, 'delay'],
    [{ closeAfterReminderMinutes: 10081 }, 'delay'],
    [{ reminderText: '  ' }, 'text'],
    [{ closeText: 'x'.repeat(1001) }, 'text'],
  ] as const)('★ %j is refused as %s', (over, why) => {
    expect(botIdleGroupProblem(write(over))).toBe(why);
  });

  it('an empty reminder is fine while the group is off; an empty close text always is', () => {
    expect(botIdleGroupProblem(write({ enabled: false, reminderText: '' }))).toBeNull();
    expect(botIdleGroupProblem(write({ closeText: '' }))).toBeNull();
  });
});
