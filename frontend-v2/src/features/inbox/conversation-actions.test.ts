import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/**
 * The verbs that change a real conversation - and they had no direct tests.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ NO REQUEST IS MADE HERE. `serverApi` is mocked for the whole file, so
 * nothing in this suite can claim, release or close anything real.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ★★ THIS MODULE WAS COVERED ONLY THROUGH `Verbs.test.tsx`, WHICH MOCKS IT.
 * Every assertion about claiming and returning to the AI was about a stub.
 * The module that performs the writes was the least-tested thing in the
 * feature - the same shape as the OIDC callback, which minted sessions and
 * had no test file beside it.
 */
const post = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ post }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('server-only', () => ({}));

const actions = async () => import('./conversation-actions');

beforeEach(() => {
  post.mockReset().mockResolvedValue({});
});

describe('⚠⚠ the two the right-click menu needed, and the platform can do', () => {
  /*
   * 02: "Right-click gives assign, pause AI, requeue, unread, resolve,
   * archive, delete." Measured against the platform's OpenAPI: five of those
   * seven have a route. `release` and `close` are the two that were missing
   * from this file.
   */
  it('★★ requeue posts to `release`, with the body `claim` is proven with', async () => {
    /*
     * ★ The schema says "no Zod schema is declared; shape is not verifiable
     *   from source" - identically for claim, release and close. `claim` is
     *   called with `{}` in production, so the other two follow it rather
     *   than inventing a body.
     */
    const { releaseConversation } = await actions();
    await expect(releaseConversation('c1')).resolves.toEqual({ ok: true });

    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {},
        endpoint: expect.objectContaining({ path: expect.stringContaining('/release') }),
      }),
    );
  });

  it('★★ resolve posts to `close`, and not to `release`', async () => {
    const { closeConversation } = await actions();
    await expect(closeConversation('c1')).resolves.toEqual({ ok: true });

    const sent = post.mock.calls.at(-1)?.[0] as { endpoint: { path: string } };
    expect(sent.endpoint.path).toContain('/close');
    expect(sent.endpoint.path).not.toContain('/release');
  });

  it('⚠⚠ a 404 is "not found", and anything else is the generic failure', async () => {
    /*
     * ⚠ NEITHER IS GIVEN A 409 MEANING. `claim` and `returnToAi` each have a
     *   documented conflict - already claimed, no AI employee - and a
     *   sentence for it. These two have no described conflict condition, so
     *   they report the generic failure rather than inventing a sentence
     *   about a state nobody has observed.
     */
    const { releaseConversation, closeConversation } = await actions();

    post.mockRejectedValue(new ApiError({ kind: 'server', status: 404 }));
    await expect(releaseConversation('c1')).resolves.toEqual({
      ok: false,
      reason: 'not_found',
    });

    /*
     * ⚠ BOTH OF THEM ON 409, AND THE FIRST VERSION ONLY CHECKED `close`.
     *   A surviving mutation added `409 -> no_ai_employee` to `release` and
     *   nothing failed: the assertion covered the sibling, not the subject.
     */
    post.mockRejectedValue(new ApiError({ kind: 'server', status: 409 }));
    await expect(closeConversation('c1')).resolves.toEqual({ ok: false, reason: 'failed' });
    await expect(releaseConversation('c1')).resolves.toEqual({ ok: false, reason: 'failed' });
  });

  it('⚠ a network failure is reported, never thrown', async () => {
    // These run from a menu item. An exception would surface as a crash on a
    // right-click rather than as a sentence.
    const { releaseConversation } = await actions();
    post.mockRejectedValue(new Error('socket hang up'));
    await expect(releaseConversation('c1')).resolves.toEqual({ ok: false, reason: 'failed' });
  });
});

describe('★ and the three verbs that were already here, now tested directly', () => {
  it('★★ claim and return-to-ai read 409 as OPPOSITE things', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * SAME STATUS, OPPOSITE MEANINGS, AND NOTHING ASSERTED IT
     * ════════════════════════════════════════════════════════════════════════
     * `claim` 409 = somebody else already has it.
     * `returnToAi` 409 = there is no AI employee to hand back to.
     *
     * The comment in the module says they "never share a sentence". Until now
     * no test said so, and a tidy-up that unified the handling would have
     * been invisible.
     */
    const { claimConversation, returnToAi } = await actions();

    post.mockRejectedValue(new ApiError({ kind: 'server', status: 409 }));
    const claimed = await claimConversation('c1');
    const returned = await returnToAi('c1');

    expect(claimed).not.toEqual(returned);
    expect(returned).toEqual({ ok: false, reason: 'no_ai_employee' });
  });

  it('★ Stop AI posts to stop-ai, never to claim; a 404 is "not found"', async () => {
    const { stopAi } = await actions();
    await expect(stopAi('c1')).resolves.toEqual({ ok: true });
    const sent = post.mock.calls.at(-1)?.[0] as { endpoint: { path: string }; body: unknown };
    expect(sent.endpoint.path).toBe('/api/conversations/c1/stop-ai');
    expect(sent.body).toEqual({});
    post.mockRejectedValue(new ApiError({ kind: 'server', status: 404 }));
    await expect(stopAi('c1')).resolves.toEqual({ ok: false, reason: 'not_found' });
  });

  it('⚠ a transfer with a blank agent never reaches the network', async () => {
    const { transferConversation } = await actions();
    await expect(transferConversation('c1', '   ')).resolves.toEqual({
      ok: false,
      reason: 'failed',
    });
    expect(post).not.toHaveBeenCalled();
  });
});
