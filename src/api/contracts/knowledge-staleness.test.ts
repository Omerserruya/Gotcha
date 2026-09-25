import { describe, expect, it } from 'vitest';

import {
  knowledgeSourceSchema,
  staleSources,
  undatedSources,
  STALE_AFTER_DAYS,
  type KnowledgeSource,
} from './knowledge';

/**
 * Screen 08's "out of date" counter.
 *
 * ★ THE THRESHOLD IS OURS AND THE DATE IS THEIRS. No staleness policy exists
 * anywhere in the platform — no field, no job, no threshold. Ninety days is
 * a judgement, chosen between the design's own "rescanned yesterday · Fresh"
 * and "last change 5 months ago · Ageing", and the screen prints the date so
 * a reader can disagree with the verdict without disagreeing with the fact.
 */

const NOW = new Date('2026-09-25T12:00:00.000Z');

const source = (over: Record<string, unknown> = {}): KnowledgeSource =>
  knowledgeSourceSchema.parse({ id: 's1', name: 'Shipping policy', ...over });

const doc = (updatedAt: string | null) => ({
  id: `d-${updatedAt ?? 'none'}`,
  title: 'A document',
  status: 'ready',
  updatedAt,
});

describe('★★ out of date, and the two things it is not', () => {
  it('counts a source whose newest document is past the threshold', () => {
    const old = source({ documents: [doc('2026-01-02T00:00:00.000Z')] });
    expect(staleSources([old], NOW)).toHaveLength(1);
  });

  it('★ dates the source by its NEWEST document, not its oldest', () => {
    // A folder with one ancient file and one from yesterday is being kept
    // up to date. Judging it by the ancient file would tell somebody to go
    // and refresh something they refreshed yesterday.
    const mixed = source({
      documents: [doc('2020-01-01T00:00:00.000Z'), doc('2026-09-24T00:00:00.000Z')],
    });
    expect(staleSources([mixed], NOW)).toHaveLength(0);
  });

  it('★★ an EMPTY source is not out of date', () => {
    /*
     * `lastRefreshed` is null for a source holding nothing. Empty and old
     * are different states with different repairs — one needs content, the
     * other needs a refresh — and counting the first as the second sends
     * somebody to re-read a folder with nothing in it.
     */
    expect(staleSources([source({ documents: [] })], NOW)).toHaveLength(0);
    expect(undatedSources([source({ documents: [] })])).toHaveLength(0);
  });

  it('★★ an UNDATED source is not out of date either — it is unknown', () => {
    /*
     * `lastRefreshed` is also null when documents exist but carry no
     * `updatedAt`. "We cannot tell when this was last read" is a different
     * thing to tell somebody than "this is old", and it is reported on its
     * own line rather than folded into the count.
     */
    const undated = source({ documents: [doc(null)] });
    expect(staleSources([undated], NOW)).toHaveLength(0);
    expect(undatedSources([undated])).toHaveLength(1);
  });

  it('★ an unparseable timestamp is unknown, never stale', () => {
    // Date.parse of rubbish is NaN, and NaN < cutoff is false. Asserted
    // rather than relied on: the safe direction must be the one the code
    // takes by construction, not by accident of comparison.
    const broken = source({
      documents: [{ ...doc('2026-01-01T00:00:00.000Z'), updatedAt: 'soon' }],
    });
    expect(staleSources([broken], NOW)).toHaveLength(0);
  });

  it('holds exactly at the boundary', () => {
    const at = new Date(NOW.getTime() - STALE_AFTER_DAYS * 86_400_000 + 1000).toISOString();
    const just = new Date(NOW.getTime() - STALE_AFTER_DAYS * 86_400_000 - 1000).toISOString();
    expect(staleSources([source({ documents: [doc(at)] })], NOW)).toHaveLength(0);
    expect(staleSources([source({ documents: [doc(just)] })], NOW)).toHaveLength(1);
  });
});
