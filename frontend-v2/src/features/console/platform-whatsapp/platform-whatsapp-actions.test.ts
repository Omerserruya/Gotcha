import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/* ⚠ Mocked - nothing is sent: these register numbers and send templates to Meta. */
const { api } = vi.hoisted(() => ({
  api: { post: vi.fn(), put: vi.fn() },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => api }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: async () => {} }));
vi.mock('@/observability/logger', () => ({ logger: { warn: vi.fn() } }));

import {
  connectPlatformNumber,
  disconnectPlatformNumber,
  savePlatformTemplate,
  setPlatformAlert,
  submitPlatformTemplate,
} from './platform-whatsapp-actions';

const refused = (status: number, error: string) =>
  new ApiError({
    kind: status === 409 ? 'conflict' : 'validation',
    status,
    developerMessage: error,
  });

beforeEach(() => {
  api.post.mockReset();
  api.put.mockReset();
  api.post.mockResolvedValue({});
  api.put.mockResolvedValue({});
});

describe('★★ the alerts number at the wire', () => {
  it('★★ connect sends the code, and only the ids Meta named', async () => {
    expect(await connectPlatformNumber('code-1', { phoneNumberId: 'pn_1' })).toEqual({ ok: true });
    const request = api.post.mock.calls[0]![0];
    expect(request.endpoint.path).toBe('/api/system/platform-whatsapp/connect');
    expect(request.body).toEqual({ code: 'code-1', phoneNumberId: 'pn_1' });
  });

  it('★★ a tenant’s number is refused in its own words', async () => {
    api.post.mockRejectedValue(refused(409, 'number_belongs_to_workspace'));
    expect(await connectPlatformNumber('c', {})).toEqual({
      ok: false,
      reason: 'number_belongs_to_workspace',
    });
  });

  it('★★ unlink is the default; retire says deregister', async () => {
    await disconnectPlatformNumber(false);
    await disconnectPlatformNumber(true);
    expect(api.post.mock.calls.map((call) => call[0].body)).toEqual([
      { deregister: false },
      { deregister: true },
    ]);
  });

  it('★★ an event type with dots reaches the route encoded as one segment', async () => {
    await savePlatformTemplate('tool.approval_required.review', 'he', 'Body {{1}} here');
    const request = api.put.mock.calls[0]![0];
    expect(request.endpoint.path).toBe(
      '/api/system/platform-whatsapp/templates/tool.approval_required.review/he',
    );
    expect(request.body).toEqual({ body: 'Body {{1}} here' });
    await submitPlatformTemplate('credit.threshold', 'en');
    expect(api.post.mock.calls[0]![0].endpoint.path).toBe(
      '/api/system/platform-whatsapp/templates/credit.threshold/en/submit',
    );
  });

  it('★★ a switch-on without both approvals is refused as template_not_approved', async () => {
    api.put.mockRejectedValue(refused(409, 'template_not_approved'));
    expect(await setPlatformAlert('credit.low', true)).toEqual({
      ok: false,
      reason: 'template_not_approved',
    });
    expect(api.put.mock.calls[0]![0].body).toEqual({ enabled: true });
  });

  it('★ a 403 is forbidden; an unknown code, or no answer, is failed', async () => {
    api.put.mockRejectedValueOnce(new ApiError({ kind: 'authorization', status: 403 }));
    expect(await setPlatformAlert('x', false)).toEqual({ ok: false, reason: 'forbidden' });
    api.put.mockRejectedValueOnce(refused(400, 'something_new'));
    expect(await setPlatformAlert('x', false)).toEqual({ ok: false, reason: 'failed' });
    api.put.mockRejectedValueOnce(new Error('socket'));
    expect(await setPlatformAlert('x', false)).toEqual({ ok: false, reason: 'failed' });
  });
});
