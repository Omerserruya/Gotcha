import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/**
 * The resolve write, at the request.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS AND `Resolve.test.tsx` IS NOT ENOUGH
 * ════════════════════════════════════════════════════════════════════════════
 * That file hands `ResolveResult` values to a component and checks the
 * sentences. **Props are a stand-in for a parse** - every one of those tests
 * passes with the body key wrong, the endpoint wrong, and `force` sent.
 *
 * The body key is the whole button: the route reads `req.body?.answer`, and
 * with any other name the next branch is `if (candidate.conflict &&
 * !editedAnswer)` → 400. Wrong key, and the control refuses every conflicted
 * row - which is every row it is drawn on. So it is asserted here, on the
 * request, where getting it wrong is visible.
 *
 * `serverApi` is mocked, so nothing reaches the platform.
 */

const post = vi.hoisted(() => vi.fn());
const get = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ post, get }) }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

/** One knowledge base carrying one document, as `GET /api/knowledge-bases` sends it. */
const bases = (status: string) => [
  {
    id: 'kb1',
    name: 'Everything',
    documents: [{ id: 'doc1', title: 'What is the minimum order?', status, chunkCount: 3 }],
  },
];

beforeEach(() => {
  post.mockReset();
  get.mockReset();
  post.mockResolvedValue({ ok: true, documentId: 'doc1' });
  get.mockResolvedValue(bases('ready'));
});

describe('★★ the request the route actually reads', () => {
  it('★★ sends the chosen answer under `answer`, not `editedAnswer`', async () => {
    const { resolveConflict } = await import('./resolve-actions');
    await resolveConflict('cand1', '₪850 minimum');

    const body = post.mock.calls[0]![0].body;
    expect(body).toEqual({ answer: '₪850 minimum' });
    // Named explicitly: `editedAnswer` is the plausible wrong key, it is the
    // name used at both other ends of the route, and it fails silently-ish -
    // as a refusal on every row rather than as an error anyone would debug.
    expect(body).not.toHaveProperty('editedAnswer');
  });

  it('★★ never sends `force`, which would skip the duplicate check', async () => {
    /*
     * The route runs the duplicate check at approval because *"approving into
     * a knowledge base that already answers this question is how it starts
     * contradicting itself"*. `force` is the switch that skips it, and a
     * one-tap button is the last place that should be overridable.
     */
    const { resolveConflict } = await import('./resolve-actions');
    await resolveConflict('cand1', '₪850');

    expect(post.mock.calls[0]![0].body).not.toHaveProperty('force');
  });

  it('★ sends neither a question nor a knowledge base id', async () => {
    // The conflict is about the answer. Rewriting the question would change
    // what the document is indexed under, and naming a base would be a
    // routing decision this panel has no basis to make.
    const { resolveConflict } = await import('./resolve-actions');
    await resolveConflict('cand1', '₪850');

    const body = post.mock.calls[0]![0].body;
    expect(body).not.toHaveProperty('question');
    expect(body).not.toHaveProperty('knowledgeBaseId');
  });

  it('★ posts to the candidate approve route with the id substituted', async () => {
    const { resolveConflict } = await import('./resolve-actions');
    await resolveConflict('cand1', '₪850');

    expect(post.mock.calls[0]![0].endpoint.path).toBe(
      '/api/historical-imports/candidates/cand1/approve',
    );
  });

  it('★★ sends `raw: true`, because the body has siblings next to no envelope', async () => {
    // `{ ok, documentId, alreadyApproved }` is the whole body. Unwrapping
    // `data` from it would parse `undefined` and lose the document id, and the
    // confirmation read would then always answer "unknown".
    const { resolveConflict } = await import('./resolve-actions');
    await resolveConflict('cand1', '₪850');

    expect(post.mock.calls[0]![0].raw).toBe(true);
  });

  it('★★ refuses an over-long answer without sending anything at all', async () => {
    const { resolveConflict } = await import('./resolve-actions');
    const result = await resolveConflict('cand1', 'x'.repeat(4001));

    expect(result).toEqual({ ok: false, reason: 'too_long' });
    // Not sent and then reported: the route would have stored it truncated
    // and answered ok.
    expect(post).not.toHaveBeenCalled();
  });
});

describe('★★ whether the AI can answer with it is a second question', () => {
  it('★★ `ok: true` with a ready document is in use', async () => {
    const { resolveConflict } = await import('./resolve-actions');
    expect(await resolveConflict('cand1', '₪850')).toEqual({
      ok: true,
      alreadyApproved: false,
      use: 'in_use',
    });
  });

  it('★★ `ok: true` with a document in error is NOT in use', async () => {
    /*
     * THE DEFECT THIS READ EXISTS FOR. The route awaits `processDocument`
     * inside a try/catch that logs and swallows, then answers `{ ok: true }`.
     * The document sits at `status: "error"` with no vectors in Qdrant, and
     * without this read the screen would promise the AI answers with it.
     */
    get.mockResolvedValue(bases('error'));
    const { resolveConflict } = await import('./resolve-actions');
    const result = await resolveConflict('cand1', '₪850');

    expect(result).toEqual({ ok: true, alreadyApproved: false, use: 'not_retrievable' });
  });

  it('★★ a failed confirmation read is unknown, never in use', async () => {
    // That read is gated on `ai:knowledge:read` - a DIFFERENT permission from
    // the write that just succeeded. A writer without it is ordinary, and
    // "in use" would be a claim built on a request that never answered.
    get.mockRejectedValue(new ApiError({ kind: 'authorization', status: 403 }));
    const { resolveConflict } = await import('./resolve-actions');
    const result = await resolveConflict('cand1', '₪850');

    expect(result).toEqual({ ok: true, alreadyApproved: false, use: 'unknown' });
  });

  it('★★ the write is still reported as done when the confirmation fails', async () => {
    // The knowledge WAS written. Reporting a failure because we could not
    // confirm it would send somebody to press again, and the second press
    // writes a duplicate.
    get.mockRejectedValue(new Error('unreachable'));
    const { resolveConflict } = await import('./resolve-actions');
    expect((await resolveConflict('cand1', '₪850')).ok).toBe(true);
  });

  it('★ a document the read cannot find is unknown', async () => {
    // It may sit in a base this reader cannot see. Absent from the list is
    // not the same as broken.
    get.mockResolvedValue([{ id: 'kb1', name: 'Everything', documents: [] }]);
    const { resolveConflict } = await import('./resolve-actions');
    expect(await resolveConflict('cand1', '₪850')).toMatchObject({ use: 'unknown' });
  });

  it('★★ no document id means nothing is confirmed, and no read is made', async () => {
    post.mockResolvedValue({ ok: true, documentId: null, alreadyApproved: true });
    const { resolveConflict } = await import('./resolve-actions');
    const result = await resolveConflict('cand1', '₪850');

    expect(result).toEqual({ ok: true, alreadyApproved: true, use: 'unknown' });
    expect(get).not.toHaveBeenCalled();
  });
});

describe('★★ the refusals, and the one that is matched on the wrong field everywhere else', () => {
  const rejectWith = (init: ConstructorParameters<typeof ApiError>[0]) =>
    post.mockRejectedValue(new ApiError(init));

  it('★★ `no_knowledge_base` arrives in `developerMessage`, because this service sends no `code`', async () => {
    /*
     * THE TRAP. Every other action in this codebase matches `cause.code`, and
     * those codes come from the shared *entitlement* envelope. This service's
     * own route answers `{ error: "no_knowledge_base", message }`, and
     * `readErrorBody` maps `error` → `developerMessage` while `code` stays
     * undefined. Matching `code` here compiles and never fires: a tenant with
     * no knowledge base would be told "something went wrong" forever, and the
     * one action that would fix it would never be named.
     */
    rejectWith({ kind: 'validation', status: 400, developerMessage: 'no_knowledge_base' });
    const { resolveConflict } = await import('./resolve-actions');

    expect(await resolveConflict('cand1', '₪850')).toEqual({
      ok: false,
      reason: 'no_knowledge_base',
    });
  });

  it('★★ 409 is already-covered, and it is a settled state rather than a fault', async () => {
    rejectWith({ kind: 'conflict', status: 409, developerMessage: 'already_covered' });
    const { resolveConflict } = await import('./resolve-actions');

    expect(await resolveConflict('cand1', '₪850')).toEqual({
      ok: false,
      reason: 'already_covered',
      title: null,
    });
  });

  it('★ 403 is a permission', async () => {
    rejectWith({ kind: 'authorization', status: 403 });
    const { resolveConflict } = await import('./resolve-actions');
    expect(await resolveConflict('cand1', '₪850')).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('★ 404 is a candidate that is no longer there', async () => {
    rejectWith({ kind: 'not_found', status: 404, developerMessage: 'Suggestion not found' });
    const { resolveConflict } = await import('./resolve-actions');
    expect(await resolveConflict('cand1', '₪850')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('★ anything else is a failure that wrote nothing', async () => {
    rejectWith({ kind: 'server', status: 500, developerMessage: 'Failed to approve suggestion' });
    const { resolveConflict } = await import('./resolve-actions');
    expect(await resolveConflict('cand1', '₪850')).toEqual({ ok: false, reason: 'failed' });
  });

  it('★ an empty answer never reaches the route', async () => {
    const { resolveConflict } = await import('./resolve-actions');
    expect(await resolveConflict('cand1', '   ')).toEqual({ ok: false, reason: 'failed' });
    expect(post).not.toHaveBeenCalled();
  });
});
