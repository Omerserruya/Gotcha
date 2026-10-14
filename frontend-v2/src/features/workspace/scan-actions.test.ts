import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/**
 * The website rescan at the wire (2026-10-14). ⚠ A real start re-crawls a
 * live site: the platform is mocked, nothing here reaches it.
 */
const { post, get } = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ post, get }) }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: vi.fn() }));
vi.mock('@/observability/logger', () => ({ logger: { warn: vi.fn() } }));

const { startWorkspaceScan, readWorkspaceScan } = await import('./actions');

beforeEach(() => {
  post.mockReset();
  get.mockReset();
});

describe('★★ starting a rescan', () => {
  it('POST /api/workspace/scan with the reader’s language; the run it started', async () => {
    post.mockResolvedValue({ status: 'running' });
    expect(await startWorkspaceScan('he')).toMatchObject({
      ok: true,
      run: { status: 'running' },
    });
    const [request] = post.mock.calls[0] as [{ endpoint: { path: string }; body: unknown }];
    expect(request.endpoint.path).toBe('/api/workspace/scan');
    expect(request.body).toEqual({ locale: 'he' });
  });

  it('★★ one already running (409 SCAN_IN_PROGRESS) is followed, never refused', async () => {
    post.mockRejectedValue(
      new ApiError({
        kind: 'conflict',
        status: 409,
        code: 'SCAN_IN_PROGRESS',
        errorData: { status: 'running', startedAt: '2026-10-14T10:00:00Z' },
      }),
    );
    expect(await startWorkspaceScan('en')).toMatchObject({
      ok: true,
      run: { status: 'running', startedAt: '2026-10-14T10:00:00Z' },
    });
    // Its run unreadable: still running, still followed.
    post.mockRejectedValue(
      new ApiError({ kind: 'conflict', status: 409, code: 'SCAN_IN_PROGRESS' }),
    );
    expect(await startWorkspaceScan('en')).toMatchObject({ ok: true, run: { status: 'running' } });
  });

  it('403 is "forbidden"; anything else, "failed"', async () => {
    post.mockRejectedValueOnce(new ApiError({ kind: 'authorization', status: 403 }));
    expect(await startWorkspaceScan()).toEqual({ ok: false, reason: 'forbidden' });
    post.mockRejectedValueOnce(
      new ApiError({ kind: 'server', status: 503, code: 'SCAN_UNAVAILABLE' }),
    );
    expect(await startWorkspaceScan()).toEqual({ ok: false, reason: 'failed' });
  });
});

describe('★★ reading it', () => {
  it('GET /api/workspace/scan: the last run, or null when none ever started', async () => {
    get.mockResolvedValueOnce({ run: { status: 'done' }, fieldSources: {} });
    expect(await readWorkspaceScan()).toMatchObject({ status: 'done' });
    expect((get.mock.calls[0]![0] as { endpoint: { path: string } }).endpoint.path).toBe(
      '/api/workspace/scan',
    );
    get.mockResolvedValueOnce({ run: null, fieldSources: {} });
    expect(await readWorkspaceScan()).toBeNull();
  });

  it('★ a read that failed is undefined - not "none ever ran"', async () => {
    get.mockRejectedValueOnce(new ApiError({ kind: 'server', status: 500 }));
    expect(await readWorkspaceScan()).toBeUndefined();
  });
});
