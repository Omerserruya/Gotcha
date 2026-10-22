import { describe, expect, it } from 'vitest';

import { confidenceBand, isDraft, suggestionsResponseSchema, suggestionSchema } from './copilot';

/** The parts of the copilot contract that decide what a reader is told. */

const s = (over: Record<string, unknown> = {}) =>
  suggestionSchema.parse({ id: 's1', text: 'Hi', ...over });

describe('★★ confidenceBand - "not reported" is not "unsure"', () => {
  it('bands a reported confidence', () => {
    expect(confidenceBand(s({ confidence: 0.95 }))).toBe('high');
    expect(confidenceBand(s({ confidence: 0.6 }))).toBe('medium');
    expect(confidenceBand(s({ confidence: 0.2 }))).toBe('low');
  });

  it('★★ an absent confidence is UNSTATED, not low', () => {
    /*
     * "The model did not say" and "the model is unsure" are different facts.
     * Filing the first as the second tells an agent to distrust a draft nothing
     * has reported anything about - the third state, on a fourth screen.
     */
    expect(confidenceBand(s({ confidence: null }))).toBe('unstated');
  });

  it('★★ a value off the scale is unstated, not low', () => {
    /*
     * A number we cannot place is not a small one. `-1` and `7` are both a
     * service sending something other than a 0-1 fraction, and clamping them
     * into "low" would publish a judgement about a draft on no basis.
     */
    expect(confidenceBand(s({ confidence: -1 }))).toBe('unstated');
    expect(confidenceBand(s({ confidence: 7 }))).toBe('unstated');
  });

  it('★ NaN cannot reach the band, because the schema refuses it first', () => {
    /*
     * Worth asserting rather than assuming: `z.number()` rejects `NaN`, so the
     * boundary stops it and `confidenceBand`'s `Number.isFinite` guard is defence
     * for a value built without parsing. Two layers, and this records which one
     * actually fires - the alternative is a guard nobody can tell is dead.
     */
    expect(() => s({ confidence: Number.NaN })).toThrow();
    expect(confidenceBand({ ...s(), confidence: Number.NaN })).toBe('unstated');
  });

  it('★ the band boundaries are inclusive at the bottom of each band', () => {
    expect(confidenceBand(s({ confidence: 0.8 }))).toBe('high');
    expect(confidenceBand(s({ confidence: 0.5 }))).toBe('medium');
    expect(confidenceBand(s({ confidence: 0 }))).toBe('low');
    expect(confidenceBand(s({ confidence: 1 }))).toBe('high');
  });
});

describe('★★ only a reply is a draft', () => {
  it('a reply is', () => {
    expect(isDraft(s({ type: 'reply' }))).toBe(true);
  });

  it('★★ an action is not, and neither is a type we have never seen', () => {
    /*
     * `type` is a free string on purpose. `z.enum(...).catch('reply')` would file
     * an unrecognised type as a draft, and a draft is the thing that gets an
     * insert affordance the day the composer exists. The safe default for "is
     * this text somebody can send" is no.
     */
    expect(isDraft(s({ type: 'quick_action' }))).toBe(false);
    expect(isDraft(s({ type: 'info' }))).toBe(false);
    expect(isDraft(s({ type: 'something_new' }))).toBe(false);
  });

  it('★ defaults to a non-draft when the type is missing entirely', () => {
    expect(isDraft(s())).toBe(false);
  });
});

describe('★★ the response keeps `copilotMode`, which sits BESIDE `data`', () => {
  it('★★ parses both halves', () => {
    /*
     * `{ data, copilotMode }` - `data` has a sibling, so the read passes
     * `raw: true`. Without it the client unwraps `data` and the mode is silently
     * discarded, and the mode is what decides which panel this is.
     */
    const parsed = suggestionsResponseSchema.parse({
      data: [{ id: 's1', text: 'Hi', type: 'reply' }],
      copilotMode: 'CHAT',
    });
    expect(parsed.copilotMode).toBe('CHAT');
    expect(parsed.data).toHaveLength(1);
  });

  it('★★ defaults the mode to READY_MESSAGE, which is what the route does', () => {
    // `copilotConfig.copilotMode || "READY_MESSAGE"` in the route itself.
    expect(suggestionsResponseSchema.parse({ data: [] }).copilotMode).toBe('READY_MESSAGE');
  });

  it('★ an absent `data` is an empty list, not a parse failure', () => {
    expect(suggestionsResponseSchema.parse({}).data).toEqual([]);
  });
});
