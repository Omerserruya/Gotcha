import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/* ⚠ A real answer writes the tenant's knowledge: the wire is mocked. */
const post = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ post }) }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: async () => {} }));
vi.mock('@/observability/logger', () => ({ logger: { warn: vi.fn() } }));

import { answerReadinessQuestion } from './readiness-answer-actions';

beforeEach(() => {
  post.mockReset();
  post.mockResolvedValue({});
});

describe('★★ E2 - answering a readiness question at the wire', () => {
  it('★ by its stable id where it has one; the answer trimmed', async () => {
    expect(
      await answerReadinessQuestion('a', { id: 'q_1', question: 'Ship abroad?' }, '  Yes. '),
    ).toEqual({ ok: true });
    expect(post.mock.calls[0]![0]).toMatchObject({
      endpoint: { path: '/api/ai-agents/a/readiness-questions/answer' },
      body: { questionId: 'q_1', answer: 'Yes.' },
    });
    expect(post.mock.calls[0]![0].body).not.toHaveProperty('question');
  });

  it('an older report, no id: by its words', async () => {
    await answerReadinessQuestion('a', { id: null, question: 'Ship abroad?' }, 'Yes.');
    expect(post.mock.calls[0]![0].body).toEqual({ question: 'Ship abroad?', answer: 'Yes.' });
  });

  it('no words, or too many: nothing sent', async () => {
    expect(await answerReadinessQuestion('a', { id: 'q', question: 'Q' }, '   ')).toEqual({
      ok: false,
      reason: 'failed',
    });
    expect(
      await answerReadinessQuestion('a', { id: 'q', question: 'Q' }, 'x'.repeat(20_001)),
    ).toEqual({ ok: false, reason: 'too_long' });
    expect(post).not.toHaveBeenCalled();
  });

  it('★ each refusal its own', async () => {
    const refuse = (init: ConstructorParameters<typeof ApiError>[0]) =>
      post.mockRejectedValueOnce(new ApiError(init));
    const ask = () => answerReadinessQuestion('a', { id: 'q', question: 'Q' }, 'A');
    refuse({ kind: 'authorization', status: 403 });
    expect(await ask()).toEqual({ ok: false, reason: 'forbidden' });
    refuse({ kind: 'not_found', status: 404, code: 'QUESTION_NOT_FOUND' });
    expect(await ask()).toEqual({ ok: false, reason: 'stale' });
    refuse({ kind: 'not_found', status: 404, code: 'AGENT_NOT_FOUND' });
    expect(await ask()).toEqual({ ok: false, reason: 'missing' });
    refuse({ kind: 'server', status: 502, code: 'NOT_LEARNED' });
    expect(await ask()).toEqual({ ok: false, reason: 'not_learned' });
    refuse({ kind: 'validation', status: 400, code: 'ANSWER_TOO_LONG' });
    expect(await ask()).toEqual({ ok: false, reason: 'too_long' });
    refuse({ kind: 'server', status: 500 });
    expect(await ask()).toEqual({ ok: false, reason: 'failed' });
  });
});
