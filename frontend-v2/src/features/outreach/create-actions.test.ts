import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/** At the wire. `serverApi` is mocked: nothing is created. */
const post = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ post }) }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { createCampaignDraft, createTemplate, duplicateTemplate } from './create-actions';

const call = () => post.mock.calls[0]![0] as { endpoint: { path: string }; body: unknown };

beforeEach(() => {
  post.mockReset();
});

describe('★★ drafts at the wire', () => {
  it('a campaign: POST /api/broadcasts with a template - no status, no send', async () => {
    post.mockResolvedValue({ id: 'b1' });
    expect(
      await createCampaignDraft({
        name: ' Autumn ',
        channelAccountId: 'wa1',
        channel: 'WHATSAPP',
        templateId: 't1',
      }),
    ).toEqual({ ok: true, id: 'b1' });
    expect(call().endpoint.path).toBe('/api/broadcasts');
    expect(call().body).toStrictEqual({
      name: 'Autumn',
      channel: 'WHATSAPP',
      channelAccountId: 'wa1',
      templateId: 't1',
    });
  });

  it('picked people: a manual audience of exactly them - the route reads audience.type manual', async () => {
    post.mockResolvedValue({ id: 'b2' });
    await createCampaignDraft({
      name: 'Picked',
      channelAccountId: 'wa1',
      channel: 'WHATSAPP',
      templateId: 't1',
      contactIds: ['k1', 'k2'],
    });
    expect(call().body).toStrictEqual({
      name: 'Picked',
      channel: 'WHATSAPP',
      channelAccountId: 'wa1',
      templateId: 't1',
      audience: { type: 'manual', contactIds: ['k1', 'k2'] },
    });
  });

  it('nothing is posted without what the route requires', async () => {
    expect(
      await createCampaignDraft({ name: 'x', channelAccountId: 'wa1', channel: 'WHATSAPP' }),
    ).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(post).not.toHaveBeenCalled();
  });

  it('a template: POST /api/templates, a DRAFT (no status sent, never submit-to-meta)', async () => {
    post.mockResolvedValue({ id: 'tp1' });
    await createTemplate({ name: 'order_ready', body: 'Hi', category: 'UTILITY', language: 'he' });
    expect(call().endpoint.path).toBe('/api/templates');
    expect(call().body).toStrictEqual({
      name: 'order_ready',
      body: 'Hi',
      category: 'UTILITY',
      language: 'he',
    });
  });

  it('duplicate: POST …/duplicate', async () => {
    post.mockResolvedValue({ id: 'tp2' });
    expect(await duplicateTemplate('tp1')).toEqual({ ok: true, id: 'tp2' });
    expect(call().endpoint.path).toBe('/api/templates/tp1/duplicate');
  });

  it('a 402 is the plan, not a failure', async () => {
    post.mockImplementation(async () => {
      throw new ApiError({ kind: 'tenant_inactive', status: 402 });
    });
    expect(
      await createCampaignDraft({
        name: 'x',
        channelAccountId: 'wa1',
        channel: 'EMAIL',
        body: 'hi',
      }),
    ).toEqual({ ok: false, reason: 'entitlement' });
  });
});
