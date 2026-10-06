import { describe, expect, it } from 'vitest';

import {
  approvableAsIs,
  bulkWouldTake,
  candidateListSchema,
  candidateSchema,
  groupOf,
  hasEvidence,
  inGroup,
  readyToAdd,
} from './knowledge-candidates';

const candidate = (over: Record<string, unknown> = {}) =>
  candidateSchema.parse({
    id: 'c1',
    question: 'Do you ship to Eilat?',
    answer: 'Yes, two to three days.',
    status: 'PENDING',
    ...over,
  });

describe('★ four groups, and the fourth is not a rejection', () => {
  it('sorts each status into its own group', () => {
    expect(groupOf(candidate())).toBe('needs_a_look');
    expect(groupOf(candidate({ status: 'APPROVED' }))).toBe('ready');
    expect(groupOf(candidate({ status: 'REJECTED' }))).toBe('rejected');
    expect(groupOf(candidate({ status: 'SUPERSEDED' }))).toBe('already_covered');
  });

  it('★ keeps SUPERSEDED out of Rejected', () => {
    /*
     * The schema's own wording: "An equivalent answer already exists in the
     * knowledge base. Surfaced as 'already covered' rather than offered as a
     * second copy of it."
     *
     * The design has three buckets and this is the fourth. Filing it under
     * Rejected would tell a reviewer their knowledge was turned down when it
     * was already in place.
     */
    const list = [candidate({ status: 'SUPERSEDED' }), candidate({ id: 'c2', status: 'REJECTED' })];
    expect(inGroup(list, 'rejected')).toHaveLength(1);
    expect(inGroup(list, 'already_covered')).toHaveLength(1);
  });
});

describe('★ a conflict cannot be approved as it stands', () => {
  it('refuses a one-press approval', () => {
    /*
     * "There is no 'the' answer to approve - that is what conflicted means."
     * The API returns `conflict_requires_answer` rather than enshrining
     * whichever variant happened to be most common.
     */
    expect(approvableAsIs(candidate({ conflict: true }))).toBe(false);
    expect(approvableAsIs(candidate())).toBe(true);
  });

  it('is not approvable once it has already been decided', () => {
    expect(approvableAsIs(candidate({ status: 'APPROVED' }))).toBe(false);
    expect(approvableAsIs(candidate({ status: 'REJECTED' }))).toBe(false);
  });
});

describe('★ "Approve all" cannot take a conflict, however it is pressed', () => {
  it('counts only what the server would accept', () => {
    /*
     * The eligible set is computed server-side - PENDING, not conflicted,
     * above a confidence floor - and the client cannot pass a list. So the
     * button is safe by construction, which is a promise worth rendering
     * rather than a footnote.
     */
    const list = [
      candidate({ confidence: 0.9 }),
      candidate({ id: 'c2', confidence: 0.9, conflict: true }),
      candidate({ id: 'c3', confidence: 0.2 }),
      candidate({ id: 'c4', confidence: 0.95, status: 'APPROVED' }),
    ];
    expect(bulkWouldTake(list, 0.8)).toBe(1);
  });

  it('takes nothing from a page of conflicts', () => {
    const list = [
      candidate({ confidence: 1, conflict: true }),
      candidate({ id: 'c2', confidence: 1, conflict: true }),
    ];
    expect(bulkWouldTake(list, 0.8)).toBe(0);
  });

  it('★★ uses the server’s own verdict, EVEN WHERE IT DISAGREES WITH OUR RULE', () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * THE ASSERTION THAT PROVES WE STOPPED RECOMPUTING
     * ════════════════════════════════════════════════════════════════════════
     * `bulkApprovable` is on every candidate and the route states why it is
     * there: *"so the bulk endpoint and the button can never disagree about
     * what 'safe' means."* The contract stripped it and this function derived
     * its own answer - which is exactly the disagreement it exists to prevent.
     *
     * So the case that matters is the one where the two answers differ. A
     * candidate the server marks approvable at a confidence BELOW the floor we
     * were handed must still be counted: the server is the authority on what
     * pressing the button does, and the number beside it is a promise about
     * that. If this test passed by agreeing with the derived rule it would
     * prove nothing.
     */
    /*
     * ★ AND THE NUMBERS ARE CHOSEN SO THE TWO RULES GIVE DIFFERENT COUNTS.
     *
     * A first version used one candidate the server accepts below the floor AND
     * one it rejects above it - the sets differ, the COUNT is 1 either way, and
     * the test passed against a version that ignored `bulkApprovable`
     * entirely. A mutation found it. Asserting a total cannot distinguish two
     * rules that happen to select the same number of different things.
     */
    const serverSaysMore = [
      candidate({ confidence: 0.2, bulkApprovable: true }),
      candidate({ id: 'c2', confidence: 0.99, bulkApprovable: true }),
    ];
    // The server takes both; our rule would take only the one above 0.8.
    expect(bulkWouldTake(serverSaysMore, 0.8)).toBe(2);

    const serverSaysFewer = [
      candidate({ confidence: 0.99, bulkApprovable: false }),
      candidate({ id: 'c2', confidence: 0.95, bulkApprovable: false }),
    ];
    // Our rule would take both; the server takes neither.
    expect(bulkWouldTake(serverSaysFewer, 0.8)).toBe(0);
  });

  it('★★ derives only when the service did not say, and from the floor it sent', () => {
    // `undefined` is "we were not told" - an older service. `false` would be a
    // claim the server excluded it, which is why the field is optional and
    // never defaulted.
    const list = [candidate({ confidence: 0.9 }), candidate({ id: 'c2', confidence: 0.2 })];
    expect(bulkWouldTake(list, 0.8)).toBe(1);
  });

  it('★★ an unstated floor counts nothing, and a floor of 0 would count everything', () => {
    /*
     * THE TRAP, CAUGHT IN A FIRST DRAFT OF THE CALLER. Passing
     * `bulkMinConfidence ?? 0` looks cautious and is the opposite: every
     * confidence is `>= 0`, so a defaulted floor counts every unconflicted
     * suggestion and OVERSTATES what pressing "approve all" would take. The
     * comment beside it claimed it meant the cautious reading.
     *
     * Undefined is a refusal: we were not told the floor, no candidate stated
     * its own verdict, so there is no number to give.
     */
    const list = [candidate({ confidence: 0.9 }), candidate({ id: 'c2', confidence: 0.01 })];

    expect(bulkWouldTake(list, undefined)).toBe(0);
    // What the defaulted version would have said - both of them.
    expect(bulkWouldTake(list, 0)).toBe(2);
  });

  it('★ a partial answer is not trusted', () => {
    /*
     * One candidate stating the flag and one not is a shape we have not seen,
     * and mixing the two rules would produce a count that is neither. Deriving
     * for all of them is at least one rule consistently applied.
     */
    const list = [
      candidate({ confidence: 0.2, bulkApprovable: true }),
      candidate({ id: 'c2', confidence: 0.9 }),
    ];
    expect(bulkWouldTake(list, 0.8)).toBe(1);
  });
});

describe('★★ the fields the candidates response was throwing away', () => {
  it('★★ keeps the server’s confidence floor, and does not invent one', () => {
    const parsed = candidateListSchema.parse({
      candidates: [],
      counts: { PENDING: 12, APPROVED: 3 },
      bulkApproveMinConfidence: 0.75,
    });
    expect(parsed.bulkApproveMinConfidence).toBe(0.75);
    expect(parsed.counts).toEqual({ PENDING: 12, APPROVED: 3 });
  });

  it('★★ a floor the service does not send stays undefined, never a number', () => {
    /*
     * A default here would be a claim about what the server would take, and
     * 13f renders a count of exactly that. The whole reason the route sends it
     * is that the client should not be guessing.
     */
    const parsed = candidateListSchema.parse({ candidates: [] });
    expect(parsed.bulkApproveMinConfidence).toBeUndefined();
    // Counts, by contrast, default to {} - reporting nothing, not zero of each.
    expect(parsed.counts).toEqual({});
  });
});

describe('★ correct and unsafe to assert are different things', () => {
  it('carries the live-lookup flag independently of confidence', () => {
    /*
     * "'We usually do viewings Thursday and Friday' is true - but an agent
     * that states it as fact will promise a slot nobody checked."
     *
     * So a candidate can be maximally confident AND unsafe to state. The flag
     * is not a quality score and must not be folded into one.
     */
    const live = candidate({ requiresLiveLookup: true, confidence: 1 });
    expect(live.requiresLiveLookup).toBe(true);
    // And it is still approvable - the caveat is about how it is USED.
    expect(approvableAsIs(live)).toBe(true);
  });
});

describe('the reviewer’s actual decision input', () => {
  it('knows when there is evidence to show', () => {
    // One agent once, against forty customers over six months.
    expect(hasEvidence(candidate({ occurrenceCount: 40, customerCount: 31 }))).toBe(true);
    expect(hasEvidence(candidate())).toBe(false);
  });

  it('keeps the duplicate document id without claiming where it came from', () => {
    // Nothing records the document's origin, so it can only ever be "already
    // in your knowledge base", never "your website".
    const dup = candidate({ status: 'SUPERSEDED', duplicateOfDocumentId: 'doc1' });
    expect(dup.duplicateOfDocumentId).toBe('doc1');
    expect(dup).not.toHaveProperty('source');
  });

  it('★ an unknown curation verdict loses the FIELD, not the whole list', () => {
    /*
     * `curation_verdict` is `String?` in the schema - no Prisma enum, no TS
     * union, and the only writer picks two values inline. So unlike every
     * other enum in these contracts, this one has no declared domain to
     * audit against: "complete" is not a claim anybody can make about it
     * today or keep true tomorrow.
     *
     * Without `.catch`, the next verdict the platform invents would fail the
     * parse - and one invalid member takes down the ENTIRE response, not the
     * field. That is exactly what `roles.2.source` did to screen 14: a 200
     * with a valid body, and five parts rendering nothing.
     *
     * So it degrades to null, which is the state the screen already handles
     * for a candidate the platform has not judged. Absence, not a guess.
     */
    const row = candidate({ curationVerdict: 'a_verdict_from_next_year' });
    expect(row.curationVerdict).toBeNull();
    // ...and the rest of the candidate survives intact, which is the point.
    expect(row.status).toBeDefined();
  });

  it('still keeps the verdicts it does know', () => {
    // `.catch` must not swallow the real values into null - that would make
    // the degradation total and silent, which is worse than the parse error.
    expect(candidate({ curationVerdict: 'live_data' }).curationVerdict).toBe('live_data');
    expect(candidate({ curationVerdict: 'rewritten' }).curationVerdict).toBe('rewritten');
  });
});

describe('★★ 13f “Ready to add” - the server’s verdict, then its floor', () => {
  const c = (over: Record<string, unknown>) =>
    candidateSchema.parse({
      id: 'x',
      question: 'q',
      answer: 'a',
      status: 'PENDING',
      confidence: 0.9,
      ...over,
    });

  it('the server’s bulkApprovable wins over any recomputation', () => {
    expect(readyToAdd(c({ bulkApprovable: false, confidence: 0.99 }), 0.8)).toBe(false);
    expect(readyToAdd(c({ bulkApprovable: true, confidence: 0.1 }), 0.8)).toBe(true);
  });

  it('without a verdict: clean and at the floor; no floor told - never', () => {
    expect(readyToAdd(c({}), 0.8)).toBe(true);
    expect(readyToAdd(c({ confidence: 0.7 }), 0.8)).toBe(false);
    expect(readyToAdd(c({ conflict: true }), 0.8)).toBe(false);
    expect(readyToAdd(c({}), undefined)).toBe(false);
  });

  it('a live lookup is ready when the route takes it - the route writes the caveat in; anything not waiting never is', () => {
    expect(readyToAdd(c({ requiresLiveLookup: true, bulkApprovable: true }), 0.8)).toBe(true);
    expect(readyToAdd(c({ requiresLiveLookup: true }), 0.8)).toBe(true);
    expect(readyToAdd(c({ status: 'APPROVED' }), 0.8)).toBe(false);
  });
});
