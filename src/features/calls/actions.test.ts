import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/**
 * The call actions at the wire. `serverApi` is mocked for the whole file:
 * nothing here dials a phone.
 */
const post = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ post }) }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { addToCall, endCall, holdCustomer, leaveCall, startCall } from './actions';

const pathOf = (call: unknown[]) => (call[0] as { endpoint: { path: string } }).endpoint.path;

beforeEach(() => {
  post.mockReset();
});

describe('★★ 05d — placing a call', () => {
  it('posts to start-outbound with the number, and the conversation when there is one', async () => {
    post.mockResolvedValue({ mode: 'AGENT_FIRST', sessionId: 's9' });
    expect(await startCall('+972501234567', 'c1')).toEqual({
      ok: true,
      mode: 'AGENT_FIRST',
      sessionId: 's9',
    });
    expect(pathOf(post.mock.calls[0]!)).toBe('/api/voice-sessions/start-outbound');
    expect(post.mock.calls[0]![0].body).toEqual({ to: '+972501234567', conversationId: 'c1' });
  });

  it('IN_PLATFORM is its own answer: the route created nothing', async () => {
    post.mockResolvedValue({ mode: 'IN_PLATFORM' });
    expect(await startCall('+972501234567')).toEqual({ ok: true, mode: 'IN_PLATFORM' });
    expect(post.mock.calls[0]![0].body).toEqual({ to: '+972501234567' });
  });

  it("the route's own refusal comes through as its code", async () => {
    post.mockImplementation(async () => {
      throw new ApiError({
        kind: 'validation',
        status: 409,
        developerMessage: 'no_active_voice_channel',
      });
    });
    expect(await startCall('+972501234567')).toEqual({
      ok: false,
      reason: 'no_active_voice_channel',
    });
    post.mockImplementation(async () => {
      throw new ApiError({ kind: 'authorization', status: 403 });
    });
    expect(await startCall('+972501234567')).toEqual({ ok: false, reason: 'forbidden' });
  });
});

describe('★★ 05e — ending and transferring', () => {
  it.each([
    ['hangup', () => endCall('s1'), '/api/voice-sessions/s1/hangup', {}],
    [
      'add-participant',
      () => addToCall('s1', '+972501234567'),
      '/api/voice-sessions/s1/add-participant',
      { to: '+972501234567' },
    ],
    [
      'customer-hold',
      () => holdCustomer('s1', true),
      '/api/voice-sessions/s1/customer-hold',
      { hold: true },
    ],
    ['agent-leave', () => leaveCall('s1'), '/api/voice-sessions/s1/agent-leave', {}],
  ] as const)('%s → its route and body', async (_, act, path, body) => {
    post.mockResolvedValue({});
    expect(await act()).toEqual({ ok: true });
    expect(pathOf(post.mock.calls[0]!)).toBe(path);
    expect(post.mock.calls[0]![0].body).toEqual(body);
  });

  it('a failure is a result, not a throw', async () => {
    post.mockImplementation(async () => {
      throw new Error('down');
    });
    expect(await endCall('s1')).toEqual({ ok: false, reason: 'failed' });
  });
});
