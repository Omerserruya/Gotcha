import { describe, expect, it } from 'vitest';

import {
  approvableAsIs,
  bulkWouldTake,
  candidateSchema,
  groupOf,
  hasEvidence,
  inGroup,
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
     * "There is no 'the' answer to approve — that is what conflicted means."
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
     * The eligible set is computed server-side — PENDING, not conflicted,
     * above a confidence floor — and the client cannot pass a list. So the
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
});

describe('★ correct and unsafe to assert are different things', () => {
  it('carries the live-lookup flag independently of confidence', () => {
    /*
     * "'We usually do viewings Thursday and Friday' is true — but an agent
     * that states it as fact will promise a slot nobody checked."
     *
     * So a candidate can be maximally confident AND unsafe to state. The flag
     * is not a quality score and must not be folded into one.
     */
    const live = candidate({ requiresLiveLookup: true, confidence: 1 });
    expect(live.requiresLiveLookup).toBe(true);
    // And it is still approvable — the caveat is about how it is USED.
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
     * `curation_verdict` is `String?` in the schema — no Prisma enum, no TS
     * union, and the only writer picks two values inline. So unlike every
     * other enum in these contracts, this one has no declared domain to
     * audit against: "complete" is not a claim anybody can make about it
     * today or keep true tomorrow.
     *
     * Without `.catch`, the next verdict the platform invents would fail the
     * parse — and one invalid member takes down the ENTIRE response, not the
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
    // `.catch` must not swallow the real values into null — that would make
    // the degradation total and silent, which is worse than the parse error.
    expect(candidate({ curationVerdict: 'live_data' }).curationVerdict).toBe('live_data');
    expect(candidate({ curationVerdict: 'rewritten' }).curationVerdict).toBe('rewritten');
  });
});
