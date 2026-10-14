import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const patch = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ patch }) }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: async () => {} }));

import { saveEmployeeEdits } from './actions';

beforeEach(() => {
  patch.mockReset();
});

describe('★ the employee page’s Save at the wire', () => {
  it('one PATCH to the employee, the body exactly as given', async () => {
    patch.mockResolvedValue({});
    expect(await saveEmployeeEdits('a', { tone: 'formal' })).toEqual({ ok: true });
    expect(patch.mock.calls[0]![0]).toMatchObject({
      endpoint: { path: '/api/ai-agents/a' },
      body: { tone: 'formal' },
    });
  });

  it('each refusal its own: forbidden, gone, a system no longer here, the rest', async () => {
    const refuse = (init: ConstructorParameters<typeof ApiError>[0]) =>
      patch.mockRejectedValueOnce(new ApiError(init));
    refuse({ kind: 'authorization', status: 403 });
    expect(await saveEmployeeEdits('a', {})).toEqual({ ok: false, reason: 'forbidden' });
    refuse({ kind: 'not_found', status: 404 });
    expect(await saveEmployeeEdits('a', {})).toEqual({ ok: false, reason: 'gone' });
    refuse({ kind: 'validation', status: 422, code: 'INVALID_INTEGRATION_ACCESS' });
    expect(await saveEmployeeEdits('a', {})).toEqual({ ok: false, reason: 'invalid_access' });
    refuse({ kind: 'validation', status: 400, code: 'INVALID_ESCALATION_RULES' });
    expect(await saveEmployeeEdits('a', {})).toEqual({ ok: false, reason: 'invalid_rules' });
    refuse({ kind: 'server', status: 500 });
    expect(await saveEmployeeEdits('a', {})).toEqual({ ok: false, reason: 'failed' });
  });

  it('★★ E4: its own rules refused - which rule, and the limit it broke', async () => {
    const refuse = (init: ConstructorParameters<typeof ApiError>[0]) =>
      patch.mockRejectedValueOnce(new ApiError(init));
    refuse({
      kind: 'validation',
      status: 400,
      code: 'GUARDRAILS_INVALID',
      reason: 'too_long',
      max: 280,
      index: 2,
    });
    expect(await saveEmployeeEdits('a', {})).toEqual({
      ok: false,
      reason: 'invalid_limits',
      why: 'too_long',
      max: 280,
      index: 2,
    });
    refuse({
      kind: 'validation',
      status: 400,
      code: 'GUARDRAILS_INVALID',
      reason: 'too_many',
      max: 20,
    });
    expect(await saveEmployeeEdits('a', {})).toMatchObject({
      why: 'too_many',
      max: 20,
      index: null,
    });
    // A reason it does not know: still its own rules, said plainly.
    refuse({
      kind: 'validation',
      status: 400,
      code: 'GUARDRAILS_INVALID',
      reason: 'not_text',
      index: 0,
    });
    expect(await saveEmployeeEdits('a', {})).toMatchObject({ why: 'other', max: null, index: 0 });
  });
});
