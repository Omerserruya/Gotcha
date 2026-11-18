import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const post = vi.hoisted(() =>
  vi.fn(async (_request: unknown): Promise<unknown> => {
    throw new Error('a test must never approve knowledge for real');
  }),
);
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ post }) }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: async () => {} }));

import { approveTopic, rejectTopic } from './topic-actions';

type Call = { endpoint: { path: string }; body: unknown; raw?: boolean };
const sent = () => post.mock.calls[0]![0] as Call;

beforeEach(() => {
  post.mockReset();
  post.mockImplementation(async () => {
    throw new Error('a test must never approve knowledge for real');
  });
  revalidatePath.mockClear();
});

describe('★★ "אישור הנושא": POST /api/historical-imports/topics/approve', () => {
  it('★ a plain approve sends no items at all', async () => {
    post.mockResolvedValueOnce({ ok: true, results: [{ candidateId: 'c1', ok: true }] });
    expect(await approveTopic('imp1', 't1', [])).toEqual({
      ok: true,
      approved: ['c1'],
      failed: [],
    });
    expect(sent().endpoint.path).toBe('/api/historical-imports/topics/approve');
    expect(sent().body).toEqual({ importId: 'imp1', topicId: 't1' });
    expect(sent().raw).toBe(true);
    expect(revalidatePath).toHaveBeenCalledWith('/[locale]/(app)/settings/channels', 'page');
  });

  it('sends the chosen answers, trimmed', async () => {
    post.mockResolvedValueOnce({ results: [] });
    await approveTopic('imp1', 't1', [{ candidateId: 'c2', answer: ' 5 days ' }]);
    expect(sent().body).toEqual({
      importId: 'imp1',
      topicId: 't1',
      items: [{ candidateId: 'c2', answer: '5 days' }],
    });
  });

  it('★ a partial approve names the items that did and did not save', async () => {
    post.mockResolvedValueOnce({
      results: [
        { candidateId: 'c1', ok: true, documentId: 'd1' },
        { candidateId: 'c2', ok: false, reason: 'embed_failed' },
      ],
    });
    expect(await approveTopic('imp1', 't1', [])).toEqual({
      ok: true,
      approved: ['c1'],
      failed: ['c2'],
    });
  });

  it('★ an answer over 4000 characters is refused before sending', async () => {
    expect(
      await approveTopic('imp1', 't1', [{ candidateId: 'c1', answer: 'x'.repeat(4001) }]),
    ).toEqual({ ok: false, reason: 'too_long' });
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    [400, 'UNRESOLVED_ITEM', undefined, 'unresolved'],
    [400, undefined, 'UNRESOLVED_ITEM', 'unresolved'],
    [400, 'ANSWER_TOO_LONG', undefined, 'too_long'],
    [404, 'TOPIC_NOT_FOUND', undefined, 'stale'],
    [403, undefined, 'forbidden', 'forbidden'],
    [400, 'SOMETHING_NEW', undefined, 'failed'],
    [500, undefined, undefined, 'failed'],
  ] as const)('%i %s/%s is "%s"', async (status, code, developerMessage, reason) => {
    post.mockRejectedValueOnce(new ApiError({ kind: 'server', status, code, developerMessage }));
    expect(await approveTopic('imp1', 't1', [])).toEqual({ ok: false, reason });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe('★★ "דחיית הנושא" and the undo of an automatic one: POST …/topics/reject', () => {
  it('sends the import and the topic', async () => {
    post.mockResolvedValueOnce({ ok: true, topicId: 't1', rejected: 2, documentsRemoved: 2 });
    expect(await rejectTopic('imp1', 't1')).toEqual({ ok: true, documentsRemoved: 2 });
    expect(sent().endpoint.path).toBe('/api/historical-imports/topics/reject');
    expect(sent().body).toEqual({ importId: 'imp1', topicId: 't1' });
  });

  it('a gone topic is "stale"; no answer at all is "failed"', async () => {
    post.mockRejectedValueOnce(new ApiError({ kind: 'not_found', status: 404 }));
    expect(await rejectTopic('imp1', 't1')).toEqual({ ok: false, reason: 'stale' });
    post.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await rejectTopic('imp1', 't1')).toEqual({ ok: false, reason: 'failed' });
  });
});
