import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

import { ApiError } from '@/api/client/api-error';

interface Call {
  readonly endpoint: { readonly path: string };
  readonly payload: z.ZodType;
  readonly body?: unknown;
}

const NEVER = 'a test must never save a template or send an email for real';
const put = vi.hoisted(() => vi.fn(async (_request: Call): Promise<unknown> => undefined));
const post = vi.hoisted(() => vi.fn(async (_request: Call): Promise<unknown> => undefined));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ put, post }) }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: async () => {} }));

import { saveEmailTemplate, sendEmailTemplateTest } from './email-template-actions';

/** Answers with `body` as the client would: parsed through the call's own schema. */
const answer = (mock: typeof put, body: unknown) =>
  mock.mockImplementationOnce(async (request) => request.payload.parse(body));

const refuse = (mock: typeof put, status: number, error: string, detailText?: string) =>
  mock.mockRejectedValueOnce(
    new ApiError({ kind: 'validation', status, developerMessage: error, detailText }),
  );

const STORED = { enabled: true, html: '<p>{{content}}</p>', updatedAt: '2026-10-22T09:00:00Z' };

beforeEach(() => {
  for (const mock of [put, post]) {
    mock.mockReset();
    mock.mockImplementation(async () => {
      throw new Error(NEVER);
    });
  }
});

describe('saveEmailTemplate: PUT /api/channels/:id/email-template', () => {
  it('sends the html and the switch, and answers the html AS STORED with what was removed', async () => {
    answer(put, { ...STORED, removed: ['script', 'on*'] });
    const result = await saveEmailTemplate('ca1', {
      enabled: true,
      html: '<p onclick="x()">{{content}}</p><script>1</script>',
    });
    expect(result).toEqual({ ok: true, template: STORED, removed: ['script', 'on*'] });
    const call = put.mock.calls[0]![0];
    expect(call.endpoint.path).toBe('/api/channels/ca1/email-template');
    expect(call.body).toEqual({
      enabled: true,
      html: '<p onclick="x()">{{content}}</p><script>1</script>',
    });
  });

  it('the toggle sends `enabled` alone, so the stored html is kept', async () => {
    answer(put, { ...STORED, enabled: false, removed: [] });
    await saveEmailTemplate('ca1', { enabled: false });
    expect(put.mock.calls[0]![0].body).toEqual({ enabled: false });
    expect(Object.keys(put.mock.calls[0]![0].body as object)).toEqual(['enabled']);
  });

  it('a removed kind the screen has no words for is dropped, not a failed save', async () => {
    answer(put, { ...STORED, removed: ['script', 'svg'] });
    const result = await saveEmailTemplate('ca1', { enabled: true, html: STORED.html });
    expect(result).toMatchObject({ ok: true, removed: ['script'] });
  });

  it('an answer without `removed` reads as nothing removed', async () => {
    answer(put, STORED);
    const result = await saveEmailTemplate('ca1', { enabled: true, html: STORED.html });
    expect(result).toMatchObject({ ok: true, removed: [] });
  });

  it.each([
    [422, 'EMAIL_TEMPLATE_CONTENT_PLACEHOLDER_MISSING', 'content_missing'],
    [422, 'EMAIL_TEMPLATE_TOO_LARGE', 'too_large'],
    [422, 'EMAIL_TEMPLATE_NOT_SET', 'not_set'],
    [403, 'Forbidden', 'forbidden'],
    [404, 'CHANNEL_NOT_FOUND', 'not_found'],
    [404, 'EMAIL_TEMPLATE_NOT_EMAIL_CHANNEL', 'not_found'],
    [400, 'VALIDATION_ERROR', 'failed'],
    [500, 'boom', 'failed'],
  ] as const)('%i %s is "%s"', async (status, error, reason) => {
    refuse(put, status, error);
    expect(await saveEmailTemplate('ca1', { enabled: true, html: 'x' })).toEqual({
      ok: false,
      reason,
    });
  });

  it('no answer at all is "failed"', async () => {
    put.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await saveEmailTemplate('ca1', { enabled: false })).toEqual({
      ok: false,
      reason: 'failed',
    });
  });
});

describe('sendEmailTemplateTest: POST /api/channels/:id/email-template/test', () => {
  it('posts no body and no recipient, and says where it went', async () => {
    answer(post, { sentTo: 'owner@halvo-dev.test' });
    expect(await sendEmailTemplateTest('ca1')).toEqual({
      ok: true,
      sentTo: 'owner@halvo-dev.test',
    });
    const call = post.mock.calls[0]![0];
    expect(call.endpoint.path).toBe('/api/channels/ca1/email-template/test');
    expect(call.body).toBeUndefined();
  });

  it('a provider refusal carries the provider’s words', async () => {
    refuse(post, 502, 'EMAIL_TEMPLATE_TEST_SEND_FAILED', 'Mailbox unavailable');
    expect(await sendEmailTemplateTest('ca1')).toEqual({
      ok: false,
      reason: 'send_failed',
      detail: 'Mailbox unavailable',
    });
  });

  it('a provider refusal without words carries none', async () => {
    refuse(post, 502, 'EMAIL_TEMPLATE_TEST_SEND_FAILED');
    expect(await sendEmailTemplateTest('ca1')).toEqual({ ok: false, reason: 'send_failed' });
  });

  it.each([
    [422, 'EMAIL_TEMPLATE_NOT_SET', 'not_set'],
    [422, 'EMAIL_TEMPLATE_NO_SENDER_ADDRESS', 'no_sender'],
    [409, 'EMAIL_TEMPLATE_CHANNEL_NOT_CONNECTED', 'not_connected'],
    [403, 'Forbidden', 'forbidden'],
    [500, 'boom', 'failed'],
  ] as const)('%i %s is "%s"', async (status, error, reason) => {
    refuse(post, status, error);
    expect(await sendEmailTemplateTest('ca1')).toEqual({ ok: false, reason });
  });
});
