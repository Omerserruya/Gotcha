import { describe, expect, it } from 'vitest';

import { queuePageSchemaForTests as queuePageSchema } from './load-inbox';

/**
 * The queue page's shape - and `undatedCount`'s third state.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THIS FILE EXISTS BECAUSE A MUTATION PASSED
 * ════════════════════════════════════════════════════════════════════════════
 * Swapping `undatedCount: z.number().optional()` for `.default(0)` broke
 * nothing: every test of this behaviour passed the value straight into the
 * component, so none of them touched the parse.
 *
 * That is the forgiving-double problem in its smallest form - the tests were
 * written by somebody who knew what the contract was supposed to say, and
 * they asserted the belief rather than the contract. The distinction lives
 * in the schema, so it is asserted in the schema.
 */

const page = (over: Record<string, unknown> = {}) => ({
  data: [],
  page: { limit: 50, hasMore: false, nextCursor: null },
  ...over,
});

describe('★★ `undatedCount` has three states and absent is not zero', () => {
  it('★★ absent stays absent, never becomes 0', () => {
    /*
     * THE DEFECT A DEFAULT WOULD CREATE.
     *
     * `undatedCount` is additive and missing from any service older than
     * it. Defaulting to 0 would have the screen assert "no undated
     * conversations" on a service that cannot answer the question - the
     * instrument reporting all-clear because it is not there, on the one
     * instrument built to detect a problem that is otherwise invisible.
     */
    const parsed = queuePageSchema.parse(page());
    expect(parsed.undatedCount).toBeUndefined();
    expect(parsed).not.toHaveProperty('undatedCount', 0);
  });

  it('★ a real zero survives, because somebody looked and found none', () => {
    expect(queuePageSchema.parse(page({ undatedCount: 0 })).undatedCount).toBe(0);
  });

  it('carries a real count', () => {
    expect(queuePageSchema.parse(page({ undatedCount: 3 })).undatedCount).toBe(3);
  });
});

describe('★ the page envelope itself', () => {
  it('★ requires `hasMore`, because absent would read as "that is all"', () => {
    // `hasMore: false` is a claim that nothing follows. A default would make
    // an older service look like a complete queue.
    expect(() =>
      queuePageSchema.parse({ data: [], page: { limit: 50, nextCursor: null } }),
    ).toThrow();
  });

  it('★ requires `nextCursor` to be present, even as null', () => {
    expect(() => queuePageSchema.parse({ data: [], page: { limit: 50, hasMore: true } })).toThrow();
  });
});
