import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const post = vi.hoisted(() => vi.fn());
const resolveConflict = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ post }) }));
vi.mock('@/features/knowledge/resolve-actions', () => ({ resolveConflict }));

import {
  addReadyAnswers,
  approveSuggestion,
  rejectSuggestion,
  rerunAnalysis,
} from './candidate-actions';

beforeEach(() => {
  post.mockReset();
  resolveConflict.mockReset();
});

describe('★★ 13f at the wire', () => {
  it('approve is 08’s approve, with the answer', async () => {
    resolveConflict.mockResolvedValue({ ok: true, alreadyApproved: false, use: 'ready' });
    await approveSuggestion('c1', '30 days');
    expect(resolveConflict).toHaveBeenCalledWith('c1', '30 days');
  });

  it('reject: POST …/candidates/c1/reject; 404 is already decided', async () => {
    post.mockResolvedValue({ ok: true });
    expect(await rejectSuggestion('c1')).toEqual({ ok: true });
    expect((post.mock.calls[0]![0] as { endpoint: { path: string } }).endpoint.path).toBe(
      '/api/historical-imports/candidates/c1/reject',
    );
    post.mockImplementation(async () => {
      throw new ApiError({ kind: 'not_found', status: 404 });
    });
    expect(await rejectSuggestion('c1')).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('★★ bulk and rerun at the wire', () => {
  it('bulk: POST …/i1/bulk-approve → how many; rerun: POST …/i1/rerun-intelligence', async () => {
    post.mockResolvedValue({ approved: 3, skipped: 1 });
    expect(await addReadyAnswers('i1')).toEqual({ ok: true, approved: 3, skipped: 1 });
    post.mockResolvedValue({ ok: true });
    expect(await rerunAnalysis('i1')).toEqual({ ok: true });
    expect(
      post.mock.calls.map((c) => (c[0] as { endpoint: { path: string } }).endpoint.path),
    ).toEqual([
      '/api/historical-imports/i1/bulk-approve',
      '/api/historical-imports/i1/rerun-intelligence',
    ]);
  });

  it('rerun 409 is "not settled"', async () => {
    post.mockImplementation(async () => {
      throw new ApiError({
        kind: 'conflict',
        status: 409,
        developerMessage: 'Import is ANALYZING at 40%',
      });
    });
    expect(await rerunAnalysis('i1')).toEqual({ ok: false, reason: 'not_settled' });
  });
});
