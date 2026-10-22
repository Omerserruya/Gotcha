import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';
import { idleAutomationSchema } from '@/api/contracts/idle-automation';

const { get, warn } = vi.hoisted(() => ({ get: vi.fn(), warn: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));
vi.mock('@/observability/logger', () => ({ logger: { warn } }));

const { loadIdleSetup } = await import('./load-idle');

beforeEach(() => {
  get.mockReset();
  warn.mockReset();
});

describe('★★ S3 - who may see follow-up and auto-close', () => {
  it('an Owner: the settings, as the read gives them', async () => {
    const settings = idleAutomationSchema.parse({
      reminderEnabled: true,
      reminderDelayMinutes: 60,
      reminderMessage: 'Hi',
      autoCloseEnabled: false,
      autoCloseDelayMinutes: 1440,
      autoCloseMessage: null,
    });
    get.mockResolvedValueOnce(settings);
    expect(await loadIdleSetup()).toEqual({ kind: 'owner', settings });
    expect(get.mock.calls[0]![0].endpoint.path).toBe('/api/agents/settings/idle-automation');
  });

  it('★ the contract: a value the route would not write reads as absent, per field', () => {
    expect(
      idleAutomationSchema.parse({
        reminderEnabled: 'yes',
        reminderDelayMinutes: 99999,
        reminderMessage: 'x'.repeat(1001),
        autoCloseDelayMinutes: 1440,
      }),
    ).toEqual({
      reminderEnabled: false,
      reminderDelayMinutes: null,
      reminderMessage: null,
      autoCloseEnabled: false,
      autoCloseDelayMinutes: 1440,
      autoCloseMessage: null,
    });
  });

  it('★★ a 403 is "not yours", not logged', async () => {
    get.mockRejectedValueOnce(new ApiError({ status: 403, kind: 'authorization' }));
    expect(await loadIdleSetup()).toEqual({ kind: 'forbidden' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('anything else is a failed read', async () => {
    get.mockRejectedValueOnce(new Error('down'));
    expect(await loadIdleSetup()).toEqual({ kind: 'failed' });
  });
});
