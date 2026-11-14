import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/* The step at the wire. ⚠ Mocked: nothing is saved. */
const { api, warn } = vi.hoisted(() => ({ api: { patch: vi.fn() }, warn: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => api }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: vi.fn(async () => {}) }));
vi.mock('@/observability/logger', () => ({ logger: { warn } }));

import { savedStepSchema } from '@/api/contracts/onboarding-v2';

import { saveStep } from './step-actions';

beforeEach(() => {
  api.patch.mockReset();
  warn.mockClear();
});

describe('★★ saving the step reached', () => {
  it('PATCH /api/onboarding/step { step }', async () => {
    api.patch.mockResolvedValue({ step: 'channels' });
    expect(await saveStep('channels')).toBe(true);
    const call = api.patch.mock.calls[0]![0];
    expect(call.endpoint.path).toBe('/api/onboarding/step');
    expect(call.body).toEqual({ step: 'channels' });
  });

  it('a failure is false and logged, never thrown', async () => {
    api.patch.mockRejectedValue(
      new ApiError({ kind: 'server', status: 500, code: 'STEP_WRITE_FAILED' }),
    );
    expect(await saveStep('live')).toBe(false);
    expect(warn).toHaveBeenCalledWith('onboarding.step_save_failed', expect.anything());
  });

  it('★ a saved step this build does not know reads as none', () => {
    expect(savedStepSchema.parse({ step: 'teleport' })).toEqual({ step: null });
    expect(savedStepSchema.parse({ step: 'done' })).toEqual({ step: 'done' });
  });
});
