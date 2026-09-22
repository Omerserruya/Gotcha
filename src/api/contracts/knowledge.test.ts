import { describe, expect, it } from 'vitest';

import {
  hasAmbiguousName,
  isOpen,
  knowledgeSourceSchema,
  lastRefreshed,
  notReadyCount,
  unansweredQuestionSchema,
  type KnowledgeSource,
} from './knowledge';

/** The rulings on screen 08, as assertions. */

const doc = (over: Partial<KnowledgeSource['documents'][number]> = {}) => ({
  id: 'd1',
  title: 'Wholesale terms',
  status: 'ready',
  chunkCount: 12,
  sourceType: 'pdf',
  sourceUrl: null,
  updatedAt: '2026-07-29T10:00:00.000Z',
  ...over,
});

const source = (over: Partial<KnowledgeSource> = {}): KnowledgeSource => ({
  id: 'k1',
  name: 'Company Knowledge',
  description: null,
  isActive: true,
  scope: 'all',
  documents: [doc()],
  ...over,
});

describe('lastRefreshed — a date, never a verdict', () => {
  it('is the newest document timestamp', () => {
    const s = source({
      documents: [
        doc({ id: 'a', updatedAt: '2026-05-01T00:00:00.000Z' }),
        doc({ id: 'b', updatedAt: '2026-07-29T10:00:00.000Z' }),
      ],
    });
    expect(lastRefreshed(s)).toBe('2026-07-29T10:00:00.000Z');
  });

  it('is null for a source holding nothing', () => {
    expect(lastRefreshed(source({ documents: [] }))).toBeNull();
  });

  it('exposes no freshness verdict anywhere in the shape', () => {
    /*
     * The design labels sources "Fresh" and counts "Out of date · 4". There
     * is NO staleness policy in the platform — no threshold, no field, no
     * job — so a verdict here would be invented, and wrong in exactly the
     * case that matters: this tenant's sources were last touched two months
     * ago.
     */
    const surface = Object.keys(knowledgeSourceSchema.parse(source()));
    expect(surface.filter((k) => /fresh|stale|outdated|expiry|age/i.test(k))).toEqual([]);
  });
});

describe('two sources can share a name, and here two do', () => {
  it('flags a name that identifies more than one source', () => {
    const a = source({ id: 'k1' });
    const b = source({ id: 'k2' });
    expect(hasAmbiguousName(a, [a, b])).toBe(true);
  });

  it('leaves a unique name alone', () => {
    const a = source({ id: 'k1', name: 'Company Knowledge' });
    const b = source({ id: 'k2', name: 'Price list' });
    expect(hasAmbiguousName(a, [a, b])).toBe(false);
  });

  it('ignores surrounding whitespace, which is not a distinction', () => {
    const a = source({ id: 'k1', name: 'Company Knowledge' });
    const b = source({ id: 'k2', name: '  Company Knowledge ' });
    expect(hasAmbiguousName(a, [a, b])).toBe(true);
  });
});

describe('a document still processing is not answering anything', () => {
  it('counts everything that is not ready', () => {
    const s = source({
      documents: [doc({ id: 'a' }), doc({ id: 'b', status: 'pending' })],
    });
    expect(notReadyCount(s)).toBe(1);
  });

  it('counts nothing when every document is ready', () => {
    expect(notReadyCount(source())).toBe(0);
  });
});

describe('unanswered questions keep the two numbers apart', () => {
  it('carries times asked and distinct askers separately', () => {
    // One person asking twenty times is a stuck customer; twenty people
    // asking once is a missing page. The design's single "asked 23 times"
    // cannot tell you which, and they need different fixes.
    const q = unansweredQuestionSchema.parse({
      id: 'q1',
      question: 'Do you ship to Eilat?',
      timesAsked: 23,
      distinctAskers: 2,
    });
    expect(q.timesAsked).toBe(23);
    expect(q.distinctAskers).toBe(2);
  });

  it('treats an unresolved question as open', () => {
    expect(isOpen(unansweredQuestionSchema.parse({ id: 'q1', resolvedAt: null }))).toBe(true);
    expect(
      isOpen(unansweredQuestionSchema.parse({ id: 'q1', resolvedAt: '2026-09-01T00:00:00Z' })),
    ).toBe(false);
  });
});
