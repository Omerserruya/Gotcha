import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';
import { webchatSettingsSchema } from '@/api/contracts/webchat';
import { widgetAssignmentSchema } from '@/api/contracts/website-widget';

const put = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ put }) }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: async () => {} }));

import { saveWebsiteWidget, saveWidgetAssignment } from './website-widget-actions';

const { displayName: _name, ...SETTINGS } = webchatSettingsSchema.parse({
  data: {
    appearance: { primaryColor: '#121212', logoUrl: null, language: 'auto', showPoweredBy: true },
    ux: {
      welcome: { assistantName: '', suggestedQuestions: [] },
      launcher: { position: 'right' },
      hero: { mediaType: 'none', mediaUrl: null },
      proactive: { enabled: false, trigger: 'time_on_page', delaySeconds: 15, message: '' },
      look: 'whatsapp',
      whatsapp: { enabled: true, channelAccountId: 'wa1' },
    },
  },
}).data;

beforeEach(() => {
  put.mockReset();
  put.mockResolvedValue({ data: { settings: SETTINGS } });
});

const sent = () => (put.mock.calls.at(-1)![0] as { body: { ux: Record<string, unknown> } }).body;

describe('★★ the widget save, stage A and stage B', () => {
  it('to a stage A service: the stage B fields stay home', async () => {
    await saveWebsiteWidget(SETTINGS);
    expect(sent().ux).not.toHaveProperty('look');
    expect(sent().ux).not.toHaveProperty('whatsapp');
  });

  it('to a stage B service: the look and the number go with the rest', async () => {
    await saveWebsiteWidget(SETTINGS, true);
    expect(sent().ux).toMatchObject({
      look: 'whatsapp',
      whatsapp: { enabled: true, channelAccountId: 'wa1' },
    });
  });

  it('★ each refusal is its own: no place yet (409), another workspace’s number (422)', async () => {
    put.mockRejectedValueOnce(
      new ApiError({ kind: 'conflict', status: 409, code: 'WIDGET_NOT_CREATED' }),
    );
    expect(await saveWebsiteWidget(SETTINGS, true)).toEqual({ ok: false, reason: 'nowhere' });
    put.mockRejectedValueOnce(
      new ApiError({ kind: 'validation', status: 422, code: 'WHATSAPP_NUMBER_NOT_FOUND' }),
    );
    expect(await saveWebsiteWidget(SETTINGS, true)).toEqual({ ok: false, reason: 'number' });
    // W1: a WhatsApp widget with no number that can take it - its own words.
    put.mockRejectedValueOnce(
      new ApiError({ kind: 'validation', status: 422, code: 'WHATSAPP_KIND_NEEDS_NUMBER' }),
    );
    expect(await saveWebsiteWidget(SETTINGS, true)).toEqual({ ok: false, reason: 'kindNumber' });
    put.mockRejectedValueOnce(new ApiError({ kind: 'server', status: 500 }));
    expect(await saveWebsiteWidget(SETTINGS, true)).toEqual({ ok: false, reason: 'failed' });
  });
});

describe('★★ who answers the widget - written to the playbook (§4.2)', () => {
  const READ = {
    channels: [
      {
        channel: 'WEBCHAT',
        employee: { id: 'e1', name: 'Maya' },
        how: 'always',
        editable: true,
        dedicated: false,
        sharedWith: ['WHATSAPP'],
      },
    ],
    employees: [{ id: 'e1', name: 'Maya', active: true }],
  };

  it('PUT /api/website-widget/assignment: the employee and the channels; the answer through the contract', async () => {
    put.mockImplementationOnce(
      async ({ payload }: { payload: { parse: (v: unknown) => unknown } }) =>
        payload.parse({
          data: { ...READ, changed: [{ channel: 'WEBCHAT', from: null, created: true }] },
        }),
    );
    const done = await saveWidgetAssignment('e1', ['WEBCHAT']);
    expect(put.mock.calls[0]![0]).toMatchObject({
      endpoint: { path: '/api/website-widget/assignment' },
      body: { employeeId: 'e1', channels: ['WEBCHAT'] },
    });
    expect((put.mock.calls[0]![0] as { body: object }).body).not.toHaveProperty('includeShared');
    expect(done).toMatchObject({ ok: true, assignment: { channels: [{ channel: 'WEBCHAT' }] } });
    await saveWidgetAssignment('e1', ['WEBCHAT'], true).catch(() => null);
    expect(put.mock.calls[1]![0]).toMatchObject({ body: { includeShared: true } });
  });

  it('★ an unknown `how` is read as conditional - never a route this screen would rewrite', () => {
    const read = widgetAssignmentSchema.parse({
      data: { ...READ, channels: [{ ...READ.channels[0], how: 'schedule' }] },
    });
    expect(read.data.channels[0]!.how).toBe('conditional');
  });

  it.each([
    [409, 'PLAYBOOK_SHARED', 'shared'],
    [409, 'PLAYBOOK_CONDITIONAL', 'conditional'],
    [422, 'EMPLOYEE_NOT_FOUND', 'employee_gone'],
    [409, 'WIDGET_NOT_CREATED', 'no_place'],
    [422, 'NO_WIDGET_CHANNEL', 'no_place'],
    [403, undefined, 'forbidden'],
    [500, undefined, 'failed'],
  ])('%s %s → %s', async (status, code, reason) => {
    put.mockRejectedValueOnce(new ApiError({ kind: 'conflict', status, code }));
    expect(await saveWidgetAssignment('e1', ['WEBCHAT'])).toEqual({ ok: false, reason });
  });
});
