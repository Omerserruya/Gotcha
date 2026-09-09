import { describe, expect, it } from 'vitest';

import type { QuietDayItem } from '@/api/contracts/analytics';

import { quietDayCopy } from './quiet-day-item';

const item = (overrides: Partial<QuietDayItem> = {}): QuietDayItem => ({
  id: 'q1',
  source: 'unanswered_question',
  effect: 'removes_work',
  wouldRemoveConversations: 30,
  basis: { askCount: 33 },
  kind: 'knowledge_gap.no_knowledge',
  values: { question: 'What is the dispatch cut-off?', askCount: 33, askedBy: 28 },
  rank: 1,
  ...overrides,
});

describe('quietDayCopy', () => {
  /*
   * The wording is keyed on the SOURCE, not the whole kind: the detail after
   * the dot says why a gap exists, not how to describe it. Keying on the full
   * kind would need a message per reason and crash on a new one.
   */
  it('keys on the source, so a new reason does not need new copy', () => {
    expect(quietDayCopy(item({ kind: 'knowledge_gap.no_knowledge' })).key).toBe('knowledge_gap');
    expect(quietDayCopy(item({ kind: 'knowledge_gap.low_confidence' })).key).toBe('knowledge_gap');
    expect(quietDayCopy(item({ kind: 'knowledge_gap.conflicting' })).key).toBe('knowledge_gap');
  });

  it('falls back rather than asking for a message that does not exist', () => {
    const copy = quietDayCopy(item({ kind: 'seasonal_spike.detected' }));
    expect(copy.key).toBe('fallback');
    expect(copy.href).toBe('/');
  });

  /*
   * The drafted message was dropped as a product decision: dormant customers
   * go through create → template approval → send. The row must not lead to a
   * draft that does not exist.
   */
  it('sends dormant customers to the campaign flow, not to a draft', () => {
    const copy = quietDayCopy(
      item({ kind: 'dormant_customers.reachable', effect: 'creates_opportunity' }),
    );
    expect(copy.key).toBe('dormant_customers');
    expect(copy.href).toBe('/outreach');
  });

  it('drops a non-scalar value rather than rendering [object Object]', () => {
    const copy = quietDayCopy(item({ values: { term: 'navy towels', meta: { a: 1 } } }));
    expect(copy.values).toEqual({ term: 'navy towels' });
  });
});
