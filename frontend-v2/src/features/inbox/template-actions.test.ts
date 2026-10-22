import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/**
 * Sending an approved template (Backend 47e376a4).
 *
 * ⚠⚠ A TEMPLATE SEND IS A REAL WHATSAPP MESSAGE. `serverApi` is mocked for the
 *    whole file; `post` and `get` record what would have gone.
 */

const post = vi.hoisted(() => vi.fn());
const get = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ post, get }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('server-only', () => ({}));

import { loadReplyTemplates, sendTemplate } from './template-actions';

beforeEach(() => {
  post.mockReset().mockResolvedValue({});
  get.mockReset().mockResolvedValue([]);
});

describe('★★ the exact request', () => {
  it('POSTs `{ templateId, variables }` to the conversation’s template route, values trimmed', async () => {
    await expect(sendTemplate('c1', 't1', { '1': '  Dana ', '2': 'A-17' })).resolves.toEqual({
      ok: true,
    });
    expect(post).toHaveBeenCalledTimes(1);
    const call = post.mock.calls[0]![0] as { endpoint: { path: string }; body: unknown };
    expect(call.endpoint.path).toBe('/api/conversations/c1/messages/template');
    expect(call.body).toEqual({ templateId: 't1', variables: { '1': 'Dana', '2': 'A-17' } });
  });

  it('★ a blank variable never reaches the route, which would send its sample or "-"', async () => {
    await expect(sendTemplate('c1', 't1', { '1': '   ' })).resolves.toEqual({
      ok: false,
      reason: 'blank',
    });
    expect(post).not.toHaveBeenCalled();
  });
});

describe('★★ its refusals, by the code the route sends', () => {
  const refuse = (status: number, code?: string, developerMessage?: string) =>
    post.mockRejectedValueOnce(
      new ApiError({
        kind: status === 409 ? 'conflict' : 'validation',
        status,
        code,
        developerMessage,
      }),
    );

  it('409 TEMPLATE_NOT_USABLE', async () => {
    refuse(409, 'TEMPLATE_NOT_USABLE');
    await expect(sendTemplate('c1', 't1', {})).resolves.toEqual({
      ok: false,
      reason: 'not_usable',
    });
  });

  it('400 TEMPLATES_WHATSAPP_ONLY', async () => {
    refuse(400, 'TEMPLATES_WHATSAPP_ONLY');
    await expect(sendTemplate('c1', 't1', {})).resolves.toEqual({
      ok: false,
      reason: 'whatsapp_only',
    });
  });

  it('400 channel not configured, and 404', async () => {
    refuse(400, undefined, 'Channel not configured for this tenant');
    await expect(sendTemplate('c1', 't1', {})).resolves.toEqual({
      ok: false,
      reason: 'channel_not_configured',
    });
    refuse(404);
    await expect(sendTemplate('c1', 't1', {})).resolves.toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('the list', () => {
  it('reads the conversation’s reply-templates route', async () => {
    await expect(loadReplyTemplates('c1')).resolves.toEqual({ ok: true, templates: [] });
    expect((get.mock.calls[0]![0] as { endpoint: { path: string } }).endpoint.path).toBe(
      '/api/conversations/c1/reply-templates',
    );
  });

  it('a failed read is a failure, never an empty list', async () => {
    get.mockRejectedValueOnce(new ApiError({ kind: 'server', status: 500 }));
    await expect(loadReplyTemplates('c1')).resolves.toEqual({ ok: false });
  });
});
