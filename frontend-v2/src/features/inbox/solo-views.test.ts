import { describe, expect, it } from 'vitest';

import {
  countViews,
  parseInboxView,
  phoneCountViews,
  phoneViews,
  railViews,
  shownView,
  SOLO_MERGED_VIEWS,
  soloView,
  viewAfter,
  viewQuery,
} from './inbox-views';
import enNav from '@/i18n/messages/en/navigation.json';
import heNav from '@/i18n/messages/he/navigation.json';

/** One person, one view (Omer, 2026-11-15): the rules, for a team and for one person. */
describe('★★ one person: "Open" in place of the queue, "Assigned to me" and "Active"', () => {
  it('★★ the rail: three views for one person, five for a team', () => {
    expect(railViews(true)).toEqual(['open', 'gotcha', 'resolved']);
    expect(railViews(false)).toEqual(['queue', 'mine', 'active', 'gotcha', 'resolved']);
  });

  it('★★ the phone: "All" first, then the rail\'s; "mine" counts its open rows', () => {
    expect(phoneViews(true)).toEqual(['all', 'open', 'gotcha', 'resolved']);
    expect(phoneViews(false)).toEqual(['all', 'queue', 'mine', 'active', 'gotcha', 'resolved']);
    expect(phoneCountViews(true)).toEqual(['all', 'open', 'gotcha', 'resolved']);
    expect(phoneCountViews(false)).toEqual([
      'all',
      'queue',
      'mine_open',
      'active',
      'gotcha',
      'resolved',
    ]);
  });

  it("★★ the counts never ask a team's route for `open` (a 400 loses every count)", () => {
    expect(countViews(false)).not.toContain('open');
    expect(countViews(false)).toEqual(['queue', 'mine', 'active', 'gotcha', 'resolved', 'all']);
    expect(countViews(true)).toEqual(['open', 'gotcha', 'resolved', 'all']);
  });

  it('★★ exactly the three merge, and only for one person', () => {
    expect(SOLO_MERGED_VIEWS).toEqual(['queue', 'mine', 'active']);
    for (const view of ['queue', 'mine', 'active'] as const) {
      expect(soloView(view, true)).toBe('open');
      expect(soloView(view, false)).toBeNull();
    }
    for (const view of ['gotcha', 'resolved', 'all', 'open'] as const) {
      expect(soloView(view, true)).toBeNull();
    }
  });

  it('★★ the bare inbox is "Open" for one person, and today\'s for a team', () => {
    expect(shownView('mine', false, true, true)).toBe('open');
    expect(shownView('mine', false, true, false)).toBe('mine');
    // A team whose viewer is unknown: "Active", as before.
    expect(shownView('mine', false, false, false)).toBe('active');
    // Named: as named - the page redirects a named merged view, it is not rewritten here.
    expect(shownView('queue', true, true, true)).toBe('queue');
  });

  it("★★ `?view=open` is a view; its query is the route's own `view=open`", () => {
    expect(parseInboxView('open')).toBe('open');
    expect(viewQuery('open', null)).toEqual({ view: 'open' });
    expect(viewQuery('open', 'me')).toEqual({ view: 'open' });
  });

  it('★ a claim lands on "Open" for one person, whoever "me" is', () => {
    expect(viewAfter('claim', true, true)).toBe('open');
    expect(viewAfter('claim', false, true)).toBe('open');
    expect(viewAfter('claim', true, false)).toBe('mine');
    expect(viewAfter('returnToAi', true, true)).toBe('gotcha');
  });

  it('★ named in both languages: "Open", and Hebrew in the singular of פעיל and טופל', () => {
    expect(enNav.inbox).toMatchObject({ open: 'Open' });
    expect(heNav.inbox).toMatchObject({ open: 'פתוח' });
  });
});
