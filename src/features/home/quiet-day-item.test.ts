import { describe, expect, it } from 'vitest';

import type { QuietDayItem } from '@/api/contracts/analytics';

import { openQuestionCount, QUIET_SOURCES, quietRows } from './quiet-day-item';

/** As `quiet-day-ranking.ts` emits them. */
const gap = (id: string, question: string, askCount: number, rank: number): QuietDayItem => ({
  id,
  source: 'unanswered_question',
  effect: 'removes_work',
  basis: {},
  kind: 'knowledge_gap.no_knowledge',
  values: { question, askCount, askedBy: askCount - 1 },
  rank,
});
const demand = (id: string, term: string, rank: number, extra = {}): QuietDayItem => ({
  id,
  source: 'product_demand',
  effect: 'removes_work',
  basis: {},
  kind: 'product_demand.not_stocked',
  values: { term, askCount: 22, askedBy: 20, weeksRunning: 2, ...extra },
  rank,
});
const dormant: QuietDayItem = {
  id: 'd',
  source: 'dormant_customers',
  effect: 'creates_opportunity',
  basis: {},
  kind: 'dormant_customers.reachable',
  values: { count: 640, quietForDays: 90 },
  rank: 9,
};

describe('★★ 01b — one row per source, in the ranker’s order', () => {
  it('two questions are ONE row: counted, listed, asked-times summed', () => {
    const rows = quietRows([gap('a', 'Dispatch cut-off?', 20, 1), gap('b', 'Gift wrap?', 13, 2)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'unanswered_question',
      key: 'gaps',
      values: { count: 2, questions: '“Dispatch cut-off?”, “Gift wrap?”', asked: 33 },
      tone: 'gap',
    });
  });

  it('groups are ordered by their best rank, whatever order they arrive in', () => {
    // Shuffled on purpose: input already in rank order cannot tell a sort from none.
    const rows = quietRows([dormant, gap('a', 'Q?', 3, 2), demand('x', 'navy towels', 1)]);
    expect(rows.map((r) => r.source)).toEqual([
      'product_demand',
      'unanswered_question',
      'dormant_customers',
    ]);
  });

  it('one term reads as itself; several as a list', () => {
    expect(quietRows([demand('x', 'navy towels', 1)])[0]).toMatchObject({
      key: 'demandOne',
      values: { term: 'navy towels', askedBy: 20, weeksRunning: 2 },
      tone: null,
    });
    expect(
      quietRows([demand('x', 'navy towels', 1), demand('y', 'king linen', 2)])[0],
    ).toMatchObject({
      key: 'demandMany',
      values: { count: 2, terms: 'navy towels, king linen', asked: 44 },
    });
  });

  it('the edge by type: amber a gap, green an opportunity, none for demand', () => {
    const tones = Object.fromEntries(
      quietRows([gap('a', 'Q?', 3, 1), demand('x', 't', 2), dormant]).map((r) => [
        r.source,
        r.tone,
      ]),
    );
    expect(tones).toEqual({
      unanswered_question: 'gap',
      product_demand: null,
      dormant_customers: 'opportunity',
    });
  });

  it('★ an item missing what its sentence needs is dropped, never an empty row', () => {
    expect(
      quietRows([demand('x', 'navy towels', 1, { askedBy: undefined, weeksRunning: undefined })]),
    ).toEqual([]);
    expect(quietRows([gap('a', '  ', 3, 1)])).toEqual([]);
  });

  it('★ a source this list does not know gets no row', () => {
    expect(quietRows([{ ...dormant, source: 'knowledge_gap' }])).toEqual([]);
  });

  it('the chip counts the ranker’s source — `unanswered_question`, not the kind', () => {
    expect(openQuestionCount([gap('a', 'Q?', 3, 1), gap('b', 'R?', 3, 2), dormant])).toBe(2);
    expect(openQuestionCount([{ ...gap('a', 'Q?', 3, 1), source: 'knowledge_gap' }])).toBe(0);
  });

  it('knows exactly the sources the ranker reports', () => {
    expect([...QUIET_SOURCES].sort()).toEqual([
      'dormant_customers',
      'knowledge_conflict',
      'product_demand',
      'unanswered_question',
    ]);
  });
});
