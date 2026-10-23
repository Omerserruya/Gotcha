import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/* /learned at the wire. ⚠ Mocked: nothing is read or rewritten. */
const { api, warn } = vi.hoisted(() => ({ api: { get: vi.fn(), patch: vi.fn() }, warn: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => api }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: vi.fn(async () => {}) }));
vi.mock('@/observability/logger', () => ({ logger: { warn } }));

import { learnedSchema } from '@/api/contracts/onboarding-v2';

import { editLearned, readLearned } from './learned-actions';

const learned = learnedSchema.parse({ policies: [], faq: [] });

beforeEach(() => {
  api.get.mockReset();
  api.patch.mockReset();
  warn.mockClear();
});

describe('★★ reading what was learned', () => {
  it('GET /learned', async () => {
    api.get.mockResolvedValue(learned);
    expect(await readLearned()).toEqual({ ok: true, learned });
    expect(api.get.mock.calls[0]![0].endpoint.path).toBe('/api/onboarding/learned');
  });

  it('★★ NOT_LEARNED is "not learned"; anything else is unread, never "nothing learned"', async () => {
    api.get.mockRejectedValueOnce(
      new ApiError({ kind: 'not_found', status: 404, code: 'NOT_LEARNED' }),
    );
    expect(await readLearned()).toEqual({ ok: false, reason: 'not_learned' });
    api.get.mockRejectedValueOnce(new ApiError({ kind: 'server', status: 500 }));
    expect(await readLearned()).toEqual({ ok: false, reason: 'unread' });
  });
});

describe('★★ correcting it', () => {
  it('PATCH /learned with the edit; the answer is the whole learned shape', async () => {
    api.patch.mockResolvedValue(learned);
    const edit = { section: 'faq', value: { q: 'Do you ship?', a: 'Yes' } } as const;
    expect(await editLearned(edit)).toEqual({ ok: true, learned });
    const call = api.patch.mock.calls[0]![0];
    expect(call.endpoint.path).toBe('/api/onboarding/learned');
    expect(call.body).toEqual(edit);
    expect(call.payload).toBe(learnedSchema);
  });

  it.each([
    ['NOT_FOUND', 'gone'],
    ['NOT_LEARNED', 'not_learned'],
    ['Q_AND_A_REQUIRED', 'incomplete'],
  ])('★ %s reads as %s', async (code, reason) => {
    api.patch.mockRejectedValue(new ApiError({ kind: 'validation', status: 400, code }));
    expect(await editLearned({ section: 'faq', id: 'f1', remove: true })).toEqual({
      ok: false,
      reason,
    });
  });

  it('anything else is failed, logged', async () => {
    api.patch.mockRejectedValue(
      new ApiError({ kind: 'server', status: 500, code: 'LEARNED_EDIT_FAILED' }),
    );
    expect(await editLearned({ section: 'brand', value: { voice: 'x' } })).toEqual({
      ok: false,
      reason: 'failed',
    });
    expect(warn).toHaveBeenCalledWith('onboarding.learned_edit_failed', expect.anything());
  });
});
