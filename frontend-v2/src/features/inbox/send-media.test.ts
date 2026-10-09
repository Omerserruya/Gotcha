import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/*
 * ⚠⚠ THE UPLOAD IS THE SEND. `browserApi` is mocked, so nothing here can
 *    reach a channel; `post` records what would have gone.
 */
const post = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/browser-api', () => ({ browserApi: { post } }));

import { MAX_MEDIA_BYTES, sendMedia } from './send-media';

const fileOf = (bytes: number) => new File([new Uint8Array(bytes)], 'a.pdf');

beforeEach(() => {
  post.mockReset().mockResolvedValue({});
});

describe('★★ a file goes as multipart, with the text as its caption', () => {
  it('sends `file` and `body` in a FormData', async () => {
    expect(await sendMedia('c1', fileOf(10), '  here  ')).toEqual({ ok: true });
    const { body, endpoint } = post.mock.calls[0]![0] as {
      body: FormData;
      endpoint: { path: string };
    };
    expect(endpoint.path).toBe('/api/conversations/c1/messages/media');
    expect(body).toBeInstanceOf(FormData);
    expect((body.get('file') as File).name).toBe('a.pdf');
    expect(body.get('body')).toBe('here');
  });

  it('and no caption field when there are no words', async () => {
    await sendMedia('c1', fileOf(10), '   ');
    expect((post.mock.calls[0]![0] as { body: FormData }).body.has('body')).toBe(false);
  });
});

describe('⚠⚠ over the cap is refused HERE - the route would send it truncated', () => {
  it('makes no request at all', async () => {
    expect(await sendMedia('c1', fileOf(MAX_MEDIA_BYTES + 1), '')).toEqual({
      ok: false,
      reason: 'too_large',
    });
    expect(post).not.toHaveBeenCalled();
  });

  it('★ and the cap itself is allowed', async () => {
    expect(await sendMedia('c1', fileOf(MAX_MEDIA_BYTES), '')).toEqual({ ok: true });
  });
});

describe('★ the route’s refusals, by name', () => {
  const refuse = (status: number, developerMessage?: string) =>
    post.mockRejectedValue(
      new ApiError({
        kind: 'validation',
        status,
        developerMessage,
        method: 'POST',
        route: '/x',
      } as never),
    );

  it('a channel with no credentials', async () => {
    refuse(400, 'Channel not configured');
    expect(await sendMedia('c1', fileOf(1), '')).toEqual({
      ok: false,
      reason: 'channel_not_configured',
    });
  });

  it('a conversation that is gone', async () => {
    refuse(404);
    expect(await sendMedia('c1', fileOf(1), '')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('anything else is a plain failure', async () => {
    refuse(500);
    expect(await sendMedia('c1', fileOf(1), '')).toEqual({ ok: false, reason: 'failed' });
  });
});
