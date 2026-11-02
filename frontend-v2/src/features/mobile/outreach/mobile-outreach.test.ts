import { describe, expect, it } from 'vitest';

import { campaignSchema } from '@/api/contracts/outreach';

import { audienceWords, sentShare, whenWords } from './mobile-outreach';

const campaign = (over: Record<string, unknown> = {}) =>
  campaignSchema.parse({
    id: 'c1',
    name: 'Black Friday',
    status: 'SENDING',
    createdAt: '2026-11-01T08:00:00.000Z',
    ...over,
  });
const at = (iso: string | null) => (iso ? `at ${iso.slice(11, 16)}` : null);

describe('★★ one sentence for when, as the desktop card says it', () => {
  it('a scheduled campaign says when it will go', () => {
    expect(
      whenWords(campaign({ status: 'SCHEDULED', scheduledAt: '2026-11-05T10:00:00.000Z' }), at),
    ).toEqual({ key: 'list.scheduledFor', when: 'at 10:00' });
  });

  it('finished before started; started before the bare status', () => {
    expect(
      whenWords(
        campaign({
          status: 'COMPLETED',
          startedAt: '2026-11-01T09:00:00.000Z',
          completedAt: '2026-11-01T09:40:00.000Z',
        }),
        at,
      ),
    ).toEqual({ key: 'list.finishedOn', when: 'at 09:40' });
    expect(whenWords(campaign({ startedAt: '2026-11-01T09:00:00.000Z' }), at)).toEqual({
      key: 'list.startedOn',
      when: 'at 09:00',
    });
  });

  it('no moment to state: the status alone, never "Sending" twice', () => {
    expect(whenWords(campaign({ status: 'DRAFT' }), at)).toEqual({ key: 'status.DRAFT' });
  });
});

describe('who it was for - never a rule in words', () => {
  const channelOf = (c: string) => (c === 'WHATSAPP' ? 'WhatsApp' : null);

  it('everyone, on a channel when it names one we can say', () => {
    expect(
      audienceWords(
        campaign({ audience: { type: 'composite', everyone: true, channel: 'WHATSAPP' } }).audience,
        channelOf,
      ),
    ).toEqual({ key: 'detail.audience.everyoneOn', values: { channel: 'WhatsApp' } });
    expect(
      audienceWords(
        campaign({ audience: { type: 'composite', everyone: true, channel: 'FAX' } }).audience,
        channelOf,
      ),
    ).toEqual({ key: 'detail.audience.everyone' });
  });

  it('hand-picked people are counted; a rule is "a saved audience"; none is "added directly"', () => {
    expect(
      audienceWords(
        campaign({ audience: { type: 'manual', contactIds: ['a', 'b'] } }).audience,
        channelOf,
      ),
    ).toEqual({ key: 'detail.audience.picked', values: { count: 2 } });
    expect(
      audienceWords(
        campaign({ audience: { type: 'filter', rules: { all: [{ field: 'x' }] } } }).audience,
        channelOf,
      ),
    ).toEqual({ key: 'detail.audience.saved' });
    expect(audienceWords(campaign().audience, channelOf)).toEqual({
      key: 'detail.audience.direct',
    });
  });
});

describe('progress is sent of recipients', () => {
  it('a share, capped at whole; nothing with nobody to send to', () => {
    expect(sentShare({ sentCount: 50, totalRecipients: 200 })).toBe(0.25);
    expect(sentShare({ sentCount: 9, totalRecipients: 5 })).toBe(1);
    expect(sentShare({ sentCount: 0, totalRecipients: 0 })).toBeNull();
  });
});
