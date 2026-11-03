import { describe, expect, it } from 'vitest';

import type { QueueChannelFilter } from '@/features/inbox/inbox-views';

import { toggleChannel } from './channel-selection';

const order: readonly QueueChannelFilter[] = ['WHATSAPP', 'INSTAGRAM', 'WEBCHAT'];

describe('toggleChannel', () => {
  it('a tick adds, a second tick removes', () => {
    expect(toggleChannel([], 'INSTAGRAM', order)).toEqual(['INSTAGRAM']);
    expect(toggleChannel(['INSTAGRAM'], 'INSTAGRAM', order)).toEqual([]);
  });

  it('★ the same ticks make the same address, in the sheet order', () => {
    expect(toggleChannel(['WEBCHAT'], 'WHATSAPP', order)).toEqual(['WHATSAPP', 'WEBCHAT']);
    expect(toggleChannel(['WHATSAPP'], 'WEBCHAT', order)).toEqual(['WHATSAPP', 'WEBCHAT']);
  });

  it('a ticked channel the sheet no longer draws is kept, at the end', () => {
    expect(toggleChannel(['EMAIL'], 'WHATSAPP', order)).toEqual(['WHATSAPP', 'EMAIL']);
  });
});
