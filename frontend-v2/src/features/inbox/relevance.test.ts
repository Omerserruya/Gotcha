import { describe, expect, it } from 'vitest';

import { conversationRowSchema, conversationRowsSchema } from '@/api/contracts/inbox';

import {
  countViews,
  HIDES_IRRELEVANT,
  INBOX_VIEW_IDS,
  parseInboxView,
  phoneCountViews,
  phoneViewQuery,
  phoneViews,
  railViews,
  viewQuery,
  withRelevance,
} from './inbox-views';
import {
  IRRELEVANT_CATEGORIES,
  relevanceCategory,
  relevanceOverride,
  relevanceTag,
} from './relevance';

/**
 * ★★ Personal and not relevant (Omer, 2026-11-17, `INBOX_RELEVANCE`): the
 * platform's label, the view that holds what is not relevant, and the main
 * views leaving it out. Off, the inbox is exactly today's.
 */

const row = (relevance: unknown) =>
  conversationRowSchema.parse({ id: 'c1', status: 'OPEN', relevance });

describe('★★ the label, as the contract reads it', () => {
  it('★★ personal, notice, marketing and automatic replies wear their tag and offer "business"', () => {
    for (const category of ['personal', 'notice', 'marketing', 'auto_reply'] as const) {
      const r = row({ category, confidence: 0.9 });
      expect(relevanceTag(r)).toBe(category);
      expect(relevanceOverride(r)).toBe('business');
    }
  });

  it('★★ a reply to our own message is a normal conversation: no tag (rule 3)', () => {
    for (const category of ['reply_to_outbound', 'business', 'unclear']) {
      const r = row({ category });
      expect(relevanceTag(r)).toBeNull();
      expect(relevanceOverride(r)).toBe('personal');
    }
  });

  it('★★ internal (our own team): stays a normal conversation, wears "Team", offers "business"', () => {
    const r = row({ category: 'internal' });
    expect(relevanceCategory(r)).toBe('internal');
    expect(relevanceTag(r)).toBe('internal');
    expect(relevanceOverride(r)).toBe('business');
    expect(IRRELEVANT_CATEGORIES).not.toContain('internal');
    expect(IRRELEVANT_CATEGORIES).toEqual(['personal', 'notice', 'marketing', 'auto_reply']);
  });

  it('★ not classified: null, absent or empty is no category and no tag', () => {
    for (const relevance of [null, undefined, { category: null }, { category: '' }]) {
      const r = row(relevance);
      expect(relevanceCategory(r)).toBeNull();
      expect(relevanceTag(r)).toBeNull();
    }
  });

  it('★★ an unknown category is "unclear": a normal conversation, never hidden', () => {
    const r = row({ category: 'spam' });
    expect(relevanceCategory(r)).toBe('unclear');
    expect(relevanceTag(r)).toBeNull();
  });

  it('★★ a malformed label never fails the row', () => {
    const rows = conversationRowsSchema.parse([
      { id: 'c1', status: 'OPEN', relevance: 'personal' },
      { id: 'c2', status: 'OPEN', relevance: { category: 7, confidence: 'high', overriddenBy: 1 } },
    ]);
    expect(rows.map((r) => r.id)).toEqual(['c1', 'c2']);
    expect(rows[0]!.relevance).toBeNull();
    expect(rows[1]!.relevance).toMatchObject({
      category: null,
      confidence: null,
      overriddenBy: null,
    });
  });

  it('★ the agreed fields arrive, an override included', () => {
    const r = row({
      category: 'business',
      confidence: 1,
      reason: 'asked about an order',
      overriddenBy: 'u1',
      overriddenAt: '2026-11-17T20:00:00Z',
      classifiedAt: null,
      source: 'override',
    });
    expect(r.relevance).toMatchObject({ overriddenBy: 'u1', source: 'override' });
  });
});

describe('★★ off: the inbox is today’s', () => {
  it('★★ no view in the rail, the phone or the counts', () => {
    for (const solo of [true, false]) {
      expect(railViews(solo)).not.toContain('irrelevant');
      expect(phoneViews(solo)).not.toContain('irrelevant');
      expect(phoneCountViews(solo)).not.toContain('irrelevant');
      // An unknown view 400s the whole count read.
      expect(countViews(solo)).not.toContain('irrelevant');
    }
    expect(countViews(false)).toEqual(['queue', 'mine', 'active', 'gotcha', 'resolved', 'all']);
    expect(countViews(true)).toEqual(['open', 'gotcha', 'resolved', 'all']);
  });

  it('★★ `?view=irrelevant` is the default view, never a list the route does not know', () => {
    expect(parseInboxView('irrelevant')).toBe('mine');
    expect(parseInboxView('irrelevant', false)).toBe('mine');
  });

  it('★★ no `hideIrrelevant` on any view', () => {
    const queryOf = withRelevance(viewQuery, false);
    expect(queryOf).toBe(viewQuery);
    for (const view of INBOX_VIEW_IDS) {
      expect(queryOf(view, 'u1') ?? {}).not.toHaveProperty('hideIrrelevant');
    }
  });
});

describe('★★ on', () => {
  it('★★ the view sits after "Handled by GOTCHA", for a team and for one person', () => {
    expect(railViews(false, true)).toEqual([
      'queue',
      'mine',
      'active',
      'gotcha',
      'irrelevant',
      'resolved',
    ]);
    expect(railViews(true, true)).toEqual(['open', 'gotcha', 'irrelevant', 'resolved']);
    expect(phoneViews(true, true)).toEqual(['all', 'open', 'gotcha', 'irrelevant', 'resolved']);
    expect(countViews(false, true)).toContain('irrelevant');
    expect(phoneCountViews(false, true)).toContain('irrelevant');
  });

  it('★★ the view asks the route for exactly it', () => {
    expect(parseInboxView('irrelevant', true)).toBe('irrelevant');
    expect(withRelevance(viewQuery, true)('irrelevant', null)).toEqual({ view: 'irrelevant' });
  });

  it('★★ the main views leave it out; Resolved, All and the view itself do not', () => {
    const queryOf = withRelevance(viewQuery, true);
    for (const view of INBOX_VIEW_IDS) {
      const query = queryOf(view, 'u1');
      if (HIDES_IRRELEVANT.includes(view)) {
        expect(query, view).toMatchObject({ ...viewQuery(view, 'u1'), hideIrrelevant: 'true' });
      } else {
        expect(query, view).toEqual(viewQuery(view, 'u1'));
      }
    }
    expect(HIDES_IRRELEVANT).toEqual(['queue', 'mine', 'active', 'open', 'gotcha']);
  });

  it('★ the phone’s "mine" keeps leaving out what was resolved, and leaves this out too', () => {
    expect(withRelevance(phoneViewQuery, true)('mine', 'u1')).toEqual({
      assignedAgentId: 'u1',
      includeAutomated: 'true',
      excludeClosed: 'true',
      hideIrrelevant: 'true',
    });
  });

  it('★ "mine" with nobody known stays no query at all', () => {
    expect(withRelevance(viewQuery, true)('mine', null)).toBeNull();
  });
});
