import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const post = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ post }) }));

import { activateVoiceNumbers, createVoiceChannel } from './voice-actions';

const SID = `AC${'0f'.repeat(16)}`;
beforeEach(() => {
  post.mockReset();
});

describe('★★ Twilio at the wire', () => {
  it('create: exactly the three fields; the numbers come back', async () => {
    post.mockImplementation(async ({ payload }: { payload: { parse: (v: unknown) => unknown } }) =>
      payload.parse({
        id: 'v1',
        numbers: [{ id: 'n1', e164: '+1555', twilioSid: 'PN1', isActive: false }],
      }),
    );
    const result = await createVoiceChannel({
      friendlyName: ' Main ',
      accountSid: SID,
      authToken: 'tok',
    });
    expect(result).toEqual({
      ok: true,
      channel: {
        id: 'v1',
        numbers: [{ id: 'n1', e164: '+1555', friendlyName: null, isActive: false }],
      },
    });
    const call = post.mock.calls[0]![0] as { endpoint: { path: string }; body: unknown };
    expect(call.endpoint.path).toBe('/api/voice-channels');
    expect(call.body).toStrictEqual({ friendlyName: 'Main', accountSid: SID, authToken: 'tok' });
  });

  it('a bad SID never leaves; 502 is Twilio refusing; 404 is not offered', async () => {
    expect(
      await createVoiceChannel({ friendlyName: 'M', accountSid: 'AC12', authToken: 't' }),
    ).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(post).not.toHaveBeenCalled();
    for (const [status, reason] of [
      [502, 'twilio'],
      [404, 'not_offered'],
      [403, 'forbidden'],
    ] as const) {
      post.mockImplementation(async () => {
        throw new ApiError({ kind: 'server', status });
      });
      expect(
        await createVoiceChannel({ friendlyName: 'M', accountSid: SID, authToken: 't' }),
      ).toEqual({
        ok: false,
        reason,
      });
    }
  });

  it('activate: one call per number; one failing stops none', async () => {
    post.mockImplementationOnce(async () => {
      throw new ApiError({ kind: 'server', status: 502 });
    });
    post.mockResolvedValueOnce({});
    expect(await activateVoiceNumbers('v1', ['n1', 'n2'])).toEqual({
      activated: ['n2'],
      failed: ['n1'],
    });
    expect(
      post.mock.calls.map((c) => (c[0] as { endpoint: { path: string } }).endpoint.path),
    ).toEqual([
      '/api/voice-channels/v1/numbers/n1/activate',
      '/api/voice-channels/v1/numbers/n2/activate',
    ]);
  });
});
