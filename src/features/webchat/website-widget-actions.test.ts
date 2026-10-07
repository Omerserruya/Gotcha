import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';
import { webchatSettingsSchema } from '@/api/contracts/webchat';

const put = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ put }) }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: async () => {} }));

import { saveWebsiteWidget } from './website-widget-actions';

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
    put.mockRejectedValueOnce(new ApiError({ kind: 'server', status: 500 }));
    expect(await saveWebsiteWidget(SETTINGS, true)).toEqual({ ok: false, reason: 'failed' });
  });
});
