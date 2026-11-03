import { describe, expect, it } from 'vitest';

import {
  filterChips,
  parseChannelFilter,
  parseChannelFilters,
  phoneCountView,
  phoneViewQuery,
  viewQuery,
} from './inbox-views';

describe("the phone's views and channels", () => {
  it('★ several channels from `a,b`, in the header order, unknown ones dropped', () => {
    expect(parseChannelFilters('INSTAGRAM,WHATSAPP')).toEqual(['WHATSAPP', 'INSTAGRAM']);
    expect(parseChannelFilters('WHATSAPP, nope ,WHATSAPP')).toEqual(['WHATSAPP']);
    expect(parseChannelFilters(undefined)).toEqual([]);
    expect(parseChannelFilters('')).toEqual([]);
  });

  it('the website still takes one, and a list is not one', () => {
    expect(parseChannelFilter('WHATSAPP')).toBe('WHATSAPP');
    expect(parseChannelFilter('WHATSAPP,INSTAGRAM')).toBeNull();
  });

  it('★ "mine" on the phone leaves out what was resolved; every other view is the website\'s', () => {
    expect(phoneViewQuery('mine', 'u1')).toEqual({
      assignedAgentId: 'u1',
      includeAutomated: 'true',
      excludeClosed: 'true',
    });
    expect(phoneViewQuery('mine', null)).toBeNull();
    for (const view of ['all', 'queue', 'active', 'gotcha', 'resolved'] as const) {
      expect(phoneViewQuery(view, 'u1')).toEqual(viewQuery(view, 'u1'));
    }
    expect(viewQuery('mine', 'u1')).not.toHaveProperty('excludeClosed');
  });

  it('★ the "mine" chip counts the same set: the count route\'s `mine_open`', () => {
    expect(phoneCountView('mine')).toBe('mine_open');
    expect(phoneCountView('queue')).toBe('queue');
  });

  it('every channel in force is drawn, connected or not', () => {
    const states = [{ channel: 'WHATSAPP', connectionStatus: 'CONNECTED', isActive: true }];
    expect(filterChips(states, false, ['INSTAGRAM', 'EMAIL']).map((c) => c.channel)).toEqual([
      'WHATSAPP',
      'INSTAGRAM',
      'EMAIL',
    ]);
    expect(filterChips(states, false, 'INSTAGRAM').map((c) => c.channel)).toEqual([
      'WHATSAPP',
      'INSTAGRAM',
    ]);
  });
});
