import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/* The site job at the wire. ⚠ Mocked: no site is read. */
const { api, signIn, warn } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn() },
  signIn: vi.fn(async () => {}),
  warn: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => api }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: signIn }));
vi.mock('@/observability/logger', () => ({ logger: { warn } }));

import { discoverJobSchema, jobStartSchema } from '@/api/contracts/onboarding-v2';

import { readScan, retryScan, startScan } from './scan-actions';

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  warn.mockClear();
});

describe('★★ starting the read', () => {
  it('★★ POST /discover/job with the host, the locale and the consent', async () => {
    api.post.mockResolvedValue({ jobId: 'j1', status: 'QUEUED', resumed: false });
    expect(await startScan('https://www.avivco.il/about', 'he')).toEqual({ ok: true });
    const call = api.post.mock.calls[0]![0];
    expect(call.endpoint.path).toBe('/api/onboarding/discover/job');
    expect(call.body).toEqual({ domain: 'avivco.il', locale: 'he', legalAccepted: true });
    expect(call.payload).toBe(jobStartSchema);
  });

  it('★ not an address: refused here, nothing sent', async () => {
    expect(await startScan('not a site', 'en')).toEqual({ ok: false, reason: 'invalid' });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('★ the route’s INVALID_DOMAIN is "invalid"; anything else is "failed", logged', async () => {
    api.post.mockRejectedValueOnce(
      new ApiError({ kind: 'validation', status: 400, code: 'INVALID_DOMAIN' }),
    );
    expect(await startScan('avivco.il', 'en')).toEqual({ ok: false, reason: 'invalid' });
    api.post.mockRejectedValueOnce(
      new ApiError({ kind: 'server', status: 500, code: 'DISCOVER_START_FAILED' }),
    );
    expect(await startScan('avivco.il', 'en')).toEqual({ ok: false, reason: 'failed' });
    expect(warn).toHaveBeenCalledWith('onboarding.scan_start_failed', expect.anything());
  });
});

describe('★★ reading the job', () => {
  it('★★ GET with since; the job comes back', async () => {
    const job = discoverJobSchema.parse({ jobId: 'j1', status: 'RUNNING' });
    api.get.mockResolvedValue(job);
    expect(await readScan(7)).toEqual({ ok: true, job });
    const call = api.get.mock.calls[0]![0];
    expect(call.endpoint.path).toBe('/api/onboarding/discover/job');
    expect(call.query).toEqual({ since: '7' });
    expect(call.payload).toBe(discoverJobSchema);
  });

  it('since is a whole number, never negative', async () => {
    api.get.mockResolvedValue(discoverJobSchema.parse({ jobId: 'j1' }));
    await readScan(-3.7);
    expect(api.get.mock.calls[0]![0].query).toEqual({ since: '0' });
  });

  it('★★ NO_JOB is "none" (back to the address); any other failure is "unread", never "none"', async () => {
    api.get.mockRejectedValueOnce(new ApiError({ kind: 'not_found', status: 404, code: 'NO_JOB' }));
    expect(await readScan(0)).toEqual({ ok: false, reason: 'none' });
    api.get.mockRejectedValueOnce(new ApiError({ kind: 'not_found', status: 404 }));
    expect(await readScan(0)).toEqual({ ok: false, reason: 'unread' });
    api.get.mockRejectedValueOnce(new ApiError({ kind: 'network' }));
    expect(await readScan(0)).toEqual({ ok: false, reason: 'unread' });
  });
});

describe('★ carrying on', () => {
  it('POST /discover/retry; done, or a finished job, are both "keep reading"', async () => {
    api.post.mockResolvedValueOnce({ jobId: 'j1', status: 'QUEUED', resumed: true });
    expect(await retryScan()).toBe(true);
    expect(api.post.mock.calls[0]![0].endpoint.path).toBe('/api/onboarding/discover/retry');
    api.post.mockRejectedValueOnce(
      new ApiError({ kind: 'conflict', status: 409, code: 'JOB_COMPLETE' }),
    );
    expect(await retryScan()).toBe(true);
  });

  it('any other failure: false, logged', async () => {
    api.post.mockRejectedValueOnce(new ApiError({ kind: 'server', status: 500 }));
    expect(await retryScan()).toBe(false);
    expect(warn).toHaveBeenCalledWith('onboarding.scan_retry_failed', expect.anything());
  });
});
