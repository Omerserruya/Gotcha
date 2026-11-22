import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/** S3's write, against a mocked platform. */
const { put } = vi.hoisted(() => ({ put: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ put }) }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: vi.fn() }));

const { saveBotIdleAutomation, saveIdleAutomation } = await import('./idle-actions');

beforeEach(() => {
  put.mockReset();
  put.mockResolvedValue({});
});

const write = (over: Record<string, unknown> = {}) => ({
  reminderEnabled: true,
  reminderDelayMinutes: 60,
  reminderMessage: ' Still there? ',
  autoCloseEnabled: false,
  autoCloseDelayMinutes: 1440,
  autoCloseMessage: '',
  ...over,
});

describe('★★ the whole object, every time', () => {
  it('all six fields, the messages trimmed', async () => {
    expect(await saveIdleAutomation(write())).toEqual({ ok: true });
    expect(put.mock.calls[0]![0].endpoint.path).toBe('/api/agents/settings/idle-automation');
    expect(put.mock.calls[0]![0].body).toEqual({
      reminderEnabled: true,
      reminderDelayMinutes: 60,
      reminderMessage: 'Still there?',
      autoCloseEnabled: false,
      autoCloseDelayMinutes: 1440,
      autoCloseMessage: '',
    });
  });

  it('★★ refused before any request: out of range, fractional, an empty reminder that is on', async () => {
    for (const over of [
      { reminderDelayMinutes: 0 },
      { autoCloseDelayMinutes: 10081 },
      { reminderDelayMinutes: 1.5 },
      { reminderMessage: '   ' },
      { autoCloseMessage: 'x'.repeat(1001) },
    ]) {
      expect(await saveIdleAutomation(write(over)), JSON.stringify(over)).toEqual({
        ok: false,
        reason: 'invalid',
      });
    }
    expect(put).not.toHaveBeenCalled();
  });

  it('an empty reminder is fine while it is off', async () => {
    expect(
      await saveIdleAutomation(write({ reminderEnabled: false, reminderMessage: '' })),
    ).toEqual({
      ok: true,
    });
  });

  it('★ a 403 is "Owner only", not a failure', async () => {
    put.mockRejectedValueOnce(new ApiError({ status: 403, kind: 'authorization' }));
    expect(await saveIdleAutomation(write())).toEqual({ ok: false, reason: 'forbidden' });
    put.mockRejectedValueOnce(new Error('down'));
    expect(await saveIdleAutomation(write())).toEqual({ ok: false, reason: 'failed' });
  });
});

describe('★★ the AI employee’s groups: only those given', () => {
  const group = {
    enabled: true,
    reminderAfterMinutes: 30,
    closeAfterReminderMinutes: 15,
    reminderText: ' Still here? ',
    closeText: '',
  };

  it('★ one group: its own route, only that group in the body', async () => {
    expect(await saveBotIdleAutomation({ messaging: group })).toEqual({ ok: true });
    expect(put.mock.calls[0]![0].endpoint.path).toBe('/api/agents/settings/bot-idle-automation');
    expect(put.mock.calls[0]![0].body).toEqual({
      messaging: { ...group, reminderText: 'Still here?' },
    });
  });

  it.each([
    ['nothing given', {}],
    ['a delay of 0', { liveChat: { ...group, reminderAfterMinutes: 0 } }],
    ['an empty reminder while on', { liveChat: { ...group, reminderText: ' ' } }],
  ])('★ %s is refused before anything is sent', async (_, groups) => {
    expect(await saveBotIdleAutomation(groups)).toEqual({ ok: false, reason: 'invalid' });
    expect(put).not.toHaveBeenCalled();
  });

  it('a 403 is "forbidden"', async () => {
    put.mockRejectedValue(new ApiError({ status: 403, kind: 'authorization' }));
    expect(await saveBotIdleAutomation({ liveChat: group })).toEqual({
      ok: false,
      reason: 'forbidden',
    });
  });
});
