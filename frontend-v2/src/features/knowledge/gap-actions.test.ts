import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const post = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ post }) }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: async () => {} }));

import { answerGap } from './gap-actions';

beforeEach(() => {
  post.mockReset();
});

describe('★★ 08 answer, at the wire', () => {
  it('POST …/unanswered-questions/:id/answer with the answer exactly as typed', async () => {
    post.mockImplementation(async ({ payload }: { payload: { parse: (v: unknown) => unknown } }) =>
      payload.parse({ resolvedAt: '2026-10-08T10:00:00Z', documentId: 'd1', resolvedBy: 'u1' }),
    );
    expect(await answerGap('q1', ' By 14:00 - next day. ')).toEqual({
      ok: true,
      resolvedAt: '2026-10-08T10:00:00Z',
    });
    expect(post.mock.calls[0]![0]).toMatchObject({
      endpoint: { path: '/api/knowledge/unanswered-questions/q1/answer' },
      body: { answer: ' By 14:00 - next day. ' },
    });
  });

  it('blank, or longer than the route keeps: refused before any call', async () => {
    expect(await answerGap('q1', '   ')).toEqual({ ok: false, reason: 'empty' });
    expect(await answerGap('q1', 'x'.repeat(20001))).toEqual({ ok: false, reason: 'too_long' });
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    [502, 'NOT_LEARNED', 'not_learned'],
    [400, 'ANSWER_REQUIRED', 'empty'],
    [400, 'ANSWER_TOO_LONG', 'too_long'],
    [404, 'QUESTION_NOT_FOUND', 'gone'],
    [403, undefined, 'forbidden'],
    [500, undefined, 'failed'],
  ])('%s %s → %s', async (status, code, reason) => {
    post.mockRejectedValueOnce(new ApiError({ kind: 'server', status, code }));
    expect(await answerGap('q1', 'By 14:00.')).toEqual({ ok: false, reason });
  });
});
