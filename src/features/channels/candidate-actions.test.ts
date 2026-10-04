import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const post = vi.hoisted(() => vi.fn());
const resolveConflict = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ post }) }));
vi.mock('@/features/knowledge/resolve-actions', () => ({ resolveConflict }));

import { approveSuggestion, rejectSuggestion } from './candidate-actions';

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
