import { describe, expect, it } from 'vitest';

import { channelAccountName, conversationRowSchema, conversationRowsSchema } from '@/api/contracts/inbox';

/**
 * ★★ Which number a conversation is on (Omer, 2026-11-16): two WhatsApp
 * numbers in one workspace, and the inbox could not say which one a customer
 * wrote to. Parsed like handledBy: nothing about it can fail a row.
 */
const row = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  status: 'OPEN',
  channel: 'WHATSAPP',
  lastMessageAt: '2026-11-16T08:00:00.000Z',
  ...over,
});
const named = (over: Record<string, unknown>) => channelAccountName(conversationRowSchema.parse(row(over)));
/** Backend c39f5c95's shape: always sent; `multipleOfChannel` says whether to show it. */
const account = (displayName: unknown, multipleOfChannel: unknown = true) => ({
  channelAccount: { id: 'ch1', channel: 'WHATSAPP', displayName, multipleOfChannel },
});

describe('★★ channelAccountName', () => {
  it('★ two or more of the channel: the name the workspace gave the account', () => {
    expect(named(account('Gotcha'))).toBe('Gotcha');
    expect(named(account('  מכירות  '))).toBe('מכירות');
  });

  it('★★ one of the channel, or the platform could not count: no tag, whatever the name', () => {
    expect(named(account('Gotcha', false))).toBeNull();
    expect(named({ channelAccount: { id: 'ch1', channel: 'WHATSAPP', displayName: 'Gotcha' } })).toBeNull();
    expect(named(account('Gotcha', 'yes'))).toBeNull();
    expect(named(account('Gotcha', 1))).toBeNull();
  });

  it('★★ absent, null (a detached conversation), empty or malformed: no account named, and the row still parses', () => {
    for (const channelAccount of [undefined, null, {}, 'Gotcha', 7, []]) {
      expect(named({ channelAccount })).toBeNull();
    }
    for (const displayName of [null, '', '   ', 42, { he: 'x' }]) {
      expect(named(account(displayName))).toBeNull();
    }
  });

  it('★★ a list with one malformed account keeps every row, and names the good ones', () => {
    const rows = conversationRowsSchema.parse([
      row({ id: 'a', ...account('GOTCHA') }),
      row({ id: 'b', ...account({ he: 'x' }) }),
      row({ id: 'c', channelAccount: 'weird' }),
      row({ id: 'd' }),
    ]);
    expect(rows.map((r) => [r.id, channelAccountName(r)])).toEqual([
      ['a', 'GOTCHA'],
      ['b', null],
      ['c', null],
      ['d', null],
    ]);
  });
});
