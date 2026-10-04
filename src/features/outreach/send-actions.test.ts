import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const post = vi.hoisted(() => vi.fn());
const get = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ post, get }) }));

import { sendCampaign, submitTemplate } from './actions';
import { wabaConnected } from './waba';

beforeEach(() => {
  post.mockReset();
  get.mockReset();
});

describe('★★ at the wire', () => {
  it('send: POST /api/broadcasts/:id/send; submit: POST /api/templates/:id/submit-to-meta', async () => {
    post.mockResolvedValue({});
    await sendCampaign('b1');
    await submitTemplate('t1');
    expect(
      post.mock.calls.map((c) => (c[0] as { endpoint: { path: string } }).endpoint.path),
    ).toEqual(['/api/broadcasts/b1/send', '/api/templates/t1/submit-to-meta']);
  });

  it('400 is refused with the platform’s reason kept; 403 an admin’s', async () => {
    post.mockImplementation(async () => {
      throw new ApiError({
        kind: 'validation',
        status: 400,
        developerMessage: 'No recipients to send to.',
      });
    });
    expect(await sendCampaign('b1')).toEqual({
      ok: false,
      reason: 'refused',
      why: 'No recipients to send to.',
    });
    post.mockImplementation(async () => {
      throw new ApiError({ kind: 'authorization', status: 403 });
    });
    expect(await submitTemplate('t1')).toEqual({ ok: false, reason: 'forbidden' });
  });
});

describe('★★ a real WhatsApp Business account', () => {
  const answer = (body: unknown) =>
    get.mockImplementation(async ({ payload }: { payload: { parse: (v: unknown) => unknown } }) =>
      payload.parse(body),
    );

  it('a connected (or degraded) profiled number: yes', async () => {
    answer({
      data: [{ id: 'n1', state: 'CONNECTED', health: { state: 'CONNECTED' } }],
      unprofiled: [],
    });
    expect(await wabaConnected()).toBe(true);
    answer({
      data: [{ id: 'n1', state: 'DEGRADED', health: { state: 'DEGRADED' } }],
      unprofiled: [],
    });
    expect(await wabaConnected()).toBe(true);
  });

  it('★ only a legacy channel (dev’s Demo WhatsApp) or a number not yet connected: no', async () => {
    answer({
      data: [],
      unprofiled: [
        {
          channelAccountId: 'c1',
          phoneNumberId: 'p1',
          name: 'Demo WhatsApp',
          connectionStatus: 'CONNECTED',
        },
      ],
    });
    expect(await wabaConnected()).toBe(false);
    answer({
      data: [{ id: 'n1', state: 'ACTION_REQUIRED', health: { state: 'ACTION_REQUIRED' } }],
      unprofiled: [],
    });
    expect(await wabaConnected()).toBe(false);
  });

  it('unread: null — nothing is offered, and it says why', async () => {
    get.mockRejectedValue(new Error('down'));
    expect(await wabaConnected()).toBeNull();
  });
});
