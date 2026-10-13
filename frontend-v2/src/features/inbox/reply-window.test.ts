import { describe, expect, it } from 'vitest';

import { ApiError } from '@/api/client/api-error';
import {
  conversationRowSchema,
  replyTemplateListSchema,
  replyWindowOf,
} from '@/api/contracts/inbox';

import { closingSoon, prefillValue, windowRefusalOf } from './reply-window';

/** The customer-service window as the composer reads it (Backend 47e376a4). */

const row = (replyWindow?: unknown) =>
  conversationRowSchema.parse({
    id: 'c1',
    status: 'OPEN',
    ...(replyWindow === undefined ? {} : { replyWindow }),
  });

describe('★★ the server fails open, so the composer does too', () => {
  it('absent, null and malformed are all free', () => {
    expect(replyWindowOf(row())).toEqual({ mode: 'free', closesAt: null });
    expect(replyWindowOf(row(null))).toEqual({ mode: 'free', closesAt: null });
    expect(replyWindowOf(row('nonsense'))).toEqual({ mode: 'free', closesAt: null });
  });

  it('★ an unknown mode is free, never a rejected row', () => {
    const r = row({ channel: 'WHATSAPP', open: false, closesAt: null, mode: 'something_new' });
    expect(replyWindowOf(r).mode).toBe('free');
  });

  it('the two closed modes are read', () => {
    expect(
      replyWindowOf(
        row({ channel: 'WHATSAPP', open: false, closesAt: null, mode: 'template_only' }),
      ),
    ).toEqual({ mode: 'template_only', closesAt: null });
    expect(
      replyWindowOf(row({ channel: 'INSTAGRAM', open: false, closesAt: null, mode: 'closed' })),
    ).toEqual({ mode: 'closed', closesAt: null });
  });

  it('★ the row keeps `closesAt` - z.object would strip a field it did not name', () => {
    const r = row({
      channel: 'WHATSAPP',
      open: true,
      closesAt: '2026-10-13T12:00:00.000Z',
      mode: 'free',
    });
    expect(replyWindowOf(r)).toEqual({ mode: 'free', closesAt: '2026-10-13T12:00:00.000Z' });
  });
});

describe('a refused send', () => {
  it('reads the two window codes from a 409, and nothing else', () => {
    const e = (status: number, code?: string) => new ApiError({ kind: 'conflict', status, code });
    expect(windowRefusalOf(e(409, 'TEMPLATE_REQUIRED'))).toBe('template_required');
    expect(windowRefusalOf(e(409, 'REPLY_WINDOW_CLOSED'))).toBe('window_closed');
    expect(windowRefusalOf(e(409, 'ALREADY_CLAIMED'))).toBeNull();
    expect(windowRefusalOf(e(400, 'TEMPLATE_REQUIRED'))).toBeNull();
    expect(windowRefusalOf(new Error('TEMPLATE_REQUIRED'))).toBeNull();
  });
});

describe('closing soon', () => {
  const now = Date.parse('2026-10-13T09:00:00.000Z');
  const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();

  it('says nothing above three hours, past the end, or with no time', () => {
    expect(closingSoon(at(181), now)).toBeNull();
    expect(closingSoon(at(0), now)).toBeNull();
    expect(closingSoon(at(-5), now)).toBeNull();
    expect(closingSoon(null, now)).toBeNull();
  });

  it('whole hours from an hour up, minutes under it', () => {
    expect(closingSoon(at(180), now)).toEqual({ unit: 'hours', count: 3 });
    expect(closingSoon(at(150), now)).toEqual({ unit: 'hours', count: 2 });
    expect(closingSoon(at(59), now)).toEqual({ unit: 'minutes', count: 59 });
  });
});

describe('a variable’s first value', () => {
  it('★ the customer’s name where the variable is a name', () => {
    expect(prefillValue({ key: 'name', sample: 'Dana' }, 'Yossi Cohen')).toBe('Yossi Cohen');
    expect(prefillValue({ key: 'first_name', sample: null }, 'Yossi Cohen')).toBe('Yossi');
    expect(prefillValue({ key: '1', sample: 'Dana' }, 'Yossi Cohen')).toBe('Yossi Cohen');
  });

  it('otherwise the sample', () => {
    expect(prefillValue({ key: '2', sample: 'A-1734' }, 'Yossi Cohen')).toBe('A-1734');
    expect(prefillValue({ key: '2', sample: null }, 'Yossi Cohen')).toBe('');
  });

  it('★ a name that is a phone number is not a name', () => {
    expect(prefillValue({ key: 'name', sample: 'Dana' }, '+972 50-123-4567')).toBe('Dana');
    expect(prefillValue({ key: 'name', sample: 'Dana' }, null)).toBe('Dana');
  });
});

describe('the template list', () => {
  it('keeps what the picker reads, from the route’s own shape', () => {
    const [t] = replyTemplateListSchema.parse([
      {
        id: 't1',
        name: 'order_update',
        language: 'he',
        category: 'UTILITY',
        body: 'Hi {{1}}, order {{2}}',
        headerType: 'TEXT',
        headerContent: 'Update',
        footer: null,
        buttons: [{ type: 'QUICK_REPLY', text: 'Thanks' }],
        placeholders: [
          { key: '1', sample: 'Dana' },
          { key: '2', sample: null },
        ],
      },
    ]);
    expect(t).toMatchObject({
      headerContent: 'Update',
      buttons: [{ text: 'Thanks' }],
      placeholders: [
        { key: '1', sample: 'Dana' },
        { key: '2', sample: null },
      ],
    });
  });
});
