import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/**
 * What the screen is told when a reply does not go out.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ NO REQUEST IS MADE HERE. `serverApi` is mocked for the whole file, so
 * nothing in this suite can reach a route that sends a message to a real person.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ★★ AND THIS IS WHERE THE HOUSE IDIOM WOULD HAVE FAILED SILENTLY.
 * The two 400s from `messages.ts` answer `{ error: "..." }` and send **no
 * `code`**. Matching `cause.code` — which every other action in this codebase
 * does — compiles here and can never fire. The reason lands in
 * `developerMessage`, so that is what is read, and these tests are the only
 * thing that would catch somebody "tidying" it back to `code`.
 */

const post = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ post }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('server-only', () => ({}));

const send = async (body: string) => {
  const { sendReply } = await import('./send-actions');
  return sendReply('c1', body);
};

beforeEach(() => {
  post.mockReset().mockResolvedValue({});
});

describe('★★ a 201 is queued, and the action says exactly that', () => {
  it('reports ok, and asks the route for the trimmed body', async () => {
    await expect(send('  Thanks for waiting  ')).resolves.toEqual({ ok: true });
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ body: { body: 'Thanks for waiting' } }),
    );
  });

  it('★★ sends no `emailReplyMode`, because the route’s default is the right one', async () => {
    /*
     * The route defaults to `reply`, which continues the customer's existing mail
     * thread, and its own comment says that is what an agent answering an email
     * expects. Passing nothing is how we get it — and passing `"new"` by accident
     * would start a fresh thread the customer has to connect by hand.
     */
    await send('Hello');
    const body = post.mock.calls[0]![0].body as Record<string, unknown>;
    expect(body).toEqual({ body: 'Hello' });
    expect(body.emailReplyMode).toBeUndefined();
  });
});

describe('★★ an empty body never reaches the route', () => {
  it('refuses whitespace without a request', async () => {
    /*
     * The route answers 400 for an empty body. A round trip to be told what we
     * already knew is worse than refusing here — and the guard is in the action,
     * not only in the component, because a server action is a public endpoint.
     */
    await expect(send('   ')).resolves.toEqual({ ok: false, reason: 'empty' });
    expect(post).not.toHaveBeenCalled();
  });
});

describe('★★ the two 400s mean different things and neither carries a code', () => {
  const refuse = (status: number, message: string) =>
    post.mockRejectedValue(new ApiError({ kind: 'validation', status, developerMessage: message }));

  it('★★ reads "Channel not configured" out of `developerMessage`', async () => {
    refuse(400, 'Channel not configured for this tenant');
    await expect(send('Hello')).resolves.toEqual({
      ok: false,
      reason: 'channel_not_configured',
    });
  });

  it('★★ reads the quote error out of `developerMessage` too', async () => {
    refuse(400, 'The message you are replying to is not in this conversation');
    await expect(send('Hello')).resolves.toEqual({ ok: false, reason: 'quote_not_here' });
  });

  it('★★ matches a narrow substring, so a full stop does not break it', async () => {
    /*
     * The wording is prose in a route nobody promised to keep. A match on the
     * whole sentence breaks the day somebody adds punctuation, and then a
     * disconnected channel reports as a generic failure and the advice becomes
     * "try again" — which cannot work.
     */
    refuse(400, 'Channel not configured for this tenant.');
    await expect(send('Hello')).resolves.toEqual({
      ok: false,
      reason: 'channel_not_configured',
    });
  });

  it('★ a 400 we do not recognise is a plain failure, not a guess', async () => {
    refuse(400, 'Something else entirely');
    await expect(send('Hello')).resolves.toEqual({ ok: false, reason: 'failed' });
  });
});

describe('the other outcomes', () => {
  it('404 is a conversation that is not there', async () => {
    post.mockRejectedValue(new ApiError({ kind: 'not_found', status: 404 }));
    await expect(send('Hello')).resolves.toEqual({ ok: false, reason: 'not_found' });
  });

  it('a non-ApiError failure is still reported, never thrown at the screen', async () => {
    post.mockRejectedValue(new Error('socket hang up'));
    await expect(send('Hello')).resolves.toEqual({ ok: false, reason: 'failed' });
  });
});
