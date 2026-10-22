import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/* ★ serverApi is a spy: nothing here reaches a server, and nothing reaches Meta. */
const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
const numbers = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get, post }) }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: vi.fn() }));
vi.mock('./load-whatsapp', () => ({ loadWhatsAppNumbers: numbers }));

import {
  loadRequiredTemplates,
  requiredForConnected,
  saveRequiredTemplate,
} from './required-templates-actions';

/** The client's own rule: unwrap `{ data }` unless the call is `raw`. */
const asTheClientDoes = (fn: typeof get, envelope: Record<string, unknown>) => () =>
  fn.mockImplementation(
    ({ payload, raw }: { payload: { parse: (v: unknown) => unknown }; raw?: boolean }) =>
      Promise.resolve(payload.parse(raw ? envelope : envelope.data)),
  );

const refusal = (status: number, code?: string, data?: Record<string, unknown>) =>
  new ApiError({
    kind: status === 403 ? 'authorization' : 'server',
    status,
    code,
    errorData: data,
  });

const input = {
  channelAccountId: 'ca1',
  role: 'reopen' as const,
  language: 'he',
  body: 'היי {{1}}, חזרנו אלייך',
  button: 'להמשך השיחה',
  submit: false,
};

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  numbers.mockReset();
});

describe('★★ the read', () => {
  it('?channelAccountId=, parsed from the route’s envelope', async () => {
    asTheClientDoes(get, {
      data: {
        channelAccountId: 'ca1',
        connectionStatus: 'CONNECTED',
        canSubmit: true,
        languages: ['he'],
        items: [
          {
            role: 'reopen',
            name: 'gotcha_reopen',
            language: 'he',
            category: 'UTILITY',
            state: 'rejected',
            templateId: 't1',
            reason: 'INVALID_FORMAT',
            body: 'היי {{1}}',
            buttons: [{ type: 'QUICK_REPLY', text: 'להמשך השיחה' }],
          },
        ],
      },
    })();
    const read = await loadRequiredTemplates('ca1');
    expect(get.mock.calls[0]![0]).toMatchObject({
      endpoint: { path: '/api/templates/required' },
      query: { channelAccountId: 'ca1' },
    });
    expect(read).toStrictEqual({
      ok: true,
      data: {
        channelAccountId: 'ca1',
        connectionStatus: 'CONNECTED',
        canSubmit: true,
        languages: ['he'],
        items: [
          {
            role: 'reopen',
            name: 'gotcha_reopen',
            language: 'he',
            category: 'UTILITY',
            state: 'rejected',
            templateId: 't1',
            reason: 'INVALID_FORMAT',
            body: 'היי {{1}}',
            buttons: ['להמשך השיחה'],
          },
        ],
      },
    });
  });

  it('an older server without canSubmit: not sendable', async () => {
    asTheClientDoes(get, { data: { channelAccountId: 'ca1', items: [] } })();
    const read = await loadRequiredTemplates('ca1');
    expect(read.ok && read.data.canSubmit).toBe(false);
  });

  it('403 is "only an Owner", not a failed read', async () => {
    get.mockRejectedValue(refusal(403));
    expect(await loadRequiredTemplates('ca1')).toStrictEqual({ ok: false, reason: 'forbidden' });
    get.mockRejectedValue(refusal(500));
    expect(await loadRequiredTemplates('ca1')).toStrictEqual({ ok: false, reason: 'failed' });
  });
});

describe('★★★ the save at the wire', () => {
  it('exactly the body the route reads; raw, because `data` has a sibling', async () => {
    asTheClientDoes(post, { data: { id: 't1' }, submitted: false })();
    expect(await saveRequiredTemplate(input)).toStrictEqual({ ok: true, submitted: false });
    const call = post.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.endpoint).toMatchObject({ path: '/api/templates/required' });
    expect(call.raw).toBe(true);
    expect(call.body).toStrictEqual({
      channelAccountId: 'ca1',
      role: 'reopen',
      language: 'he',
      body: 'היי {{1}}, חזרנו אלייך',
      button: 'להמשך השיחה',
      submit: false,
    });
  });

  it('submitted: true is read from beside `data`', async () => {
    asTheClientDoes(post, { data: { id: 't1' }, meta: {}, submitted: true })();
    expect(await saveRequiredTemplate({ ...input, submit: true })).toStrictEqual({
      ok: true,
      submitted: true,
    });
  });

  it.each([
    [refusal(409, 'NUMBER_NOT_CONNECTED', { id: 't1' }), { reason: 'not_connected' }],
    [
      refusal(409, 'ALREADY_SUBMITTED', { id: 't7', status: 'APPROVED' }),
      { reason: 'already_submitted', templateId: 't7' },
    ],
    [refusal(403), { reason: 'forbidden' }],
    [refusal(400, 'BAD_BODY'), { reason: 'bad_body' }],
    [refusal(400), { reason: 'refused' }],
    [refusal(404, 'NUMBER_NOT_FOUND'), { reason: 'not_found' }],
    [refusal(500), { reason: 'failed' }],
  ])('%s', async (cause, expected) => {
    post.mockRejectedValue(cause);
    expect(await saveRequiredTemplate({ ...input, submit: true })).toStrictEqual({
      ok: false,
      ...expected,
    });
  });
});

describe('★ right after a connect: which channel account', () => {
  beforeEach(() => {
    asTheClientDoes(get, { data: { channelAccountId: 'x', items: [] } })();
  });

  it('an unprofiled number by Meta’s id', async () => {
    numbers.mockResolvedValue({
      data: [],
      unprofiled: [{ channelAccountId: 'ca9', phoneNumberId: 'p1', phoneNumber: null }],
    });
    const out = await requiredForConnected('p1', '+972 52 611 0290');
    expect(out?.channelAccountId).toBe('ca9');
    expect(get.mock.calls[0]![0]).toMatchObject({ query: { channelAccountId: 'ca9' } });
  });

  it('a profiled number by its digits', async () => {
    numbers.mockResolvedValue({
      data: [
        { channelAccountId: 'ca2', phoneNumber: '+972 3 555 0000' },
        { channelAccountId: 'ca3', phoneNumber: '+972-52-611-0290' },
      ],
      unprofiled: [],
    });
    expect((await requiredForConnected('p1', '+972 52 611 0290'))?.channelAccountId).toBe('ca3');
  });

  it('not on the list yet, or the list unread: null, and nothing read', async () => {
    numbers.mockResolvedValue({ data: [], unprofiled: [] });
    expect(await requiredForConnected('p1', '+972 52 611 0290')).toBeNull();
    numbers.mockResolvedValue(null);
    expect(await requiredForConnected('p1', null)).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });
});
