import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { messageSchema, undeliveredReason } from '@/api/contracts/inbox';
import en from '@/i18n/messages/en/inbox.json';
import he from '@/i18n/messages/he/inbox.json';

import { MessageStream } from './MessageStream';
import { streamUndelivered } from './undelivered';

/**
 * A WhatsApp message Meta could not give us (`type: "unsupported"`), stored as
 * the body `[unsupported message]` with Meta's `errors[]` kept beside it
 * (whatsapp.adapter.ts `unmodelled`: `{ providerType, errors, raw: msg }`).
 * It read "WhatsApp calls it 'unsupported'": an English word that explained
 * nothing (Supervisior, 2026-11-17). Now the code says what happened.
 */

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'inbox') =>
    createTranslator({ locale: 'he', messages: { inbox: he }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'he', timeZone: 'Asia/Jerusalem' }),
}));

const message = (over: Record<string, unknown>) =>
  messageSchema.parse({
    id: 'u1',
    direction: 'INBOUND',
    body: '[unsupported message]',
    messageType: 'text',
    createdAt: '2026-11-17T09:00:00.000Z',
    ...over,
  });

/** As the adapter stores it: the reduced errors, and Meta's message as raw. */
const unsupported = (code: number | undefined, id = 'u1') =>
  message({
    id,
    metadata: {
      unsupported: {
        providerType: 'unsupported',
        errors: code === undefined ? [] : [{ code, title: 'x' }],
        raw: {
          type: 'unsupported',
          ...(code === undefined ? {} : { errors: [{ code, title: 'x' }] }),
        },
      },
    },
  });

const stream = async (messages: unknown[]) =>
  render(await MessageStream({ messages: messages as never, channel: 'WHATSAPP' }));

describe('★★ the reason, by Meta’s code', () => {
  it.each([
    [131060, 'phoneOnly', he.stream.undelivered.phoneOnly],
    [131051, 'notForwarded', he.stream.undelivered.notForwarded],
    [131000, 'notArrived', he.stream.undelivered.notArrived],
    [undefined, 'notArrived', he.stream.undelivered.notArrived],
  ] as const)('code %s → %s', async (code, reason, words) => {
    const m = unsupported(code);
    expect(undeliveredReason(m)).toBe(reason);
    await stream([m]);
    expect(screen.getByTestId('undelivered-u1')).toHaveTextContent(words);
    expect(screen.queryByText('[unsupported message]')).toBeNull();
    expect(screen.queryByTestId('unsupported-u1')).toBeNull();
  });

  it('a row with the code only in raw (Meta’s own errors) is read the same', () => {
    const m = message({
      metadata: {
        unsupported: { providerType: 'unsupported', raw: { errors: [{ code: 131060 }] } },
      },
    });
    expect(undeliveredReason(m)).toBe('phoneOnly');
  });

  it('a code sent as a string is the same code', () => {
    const m = message({
      metadata: { unsupported: { providerType: 'unsupported', errors: [{ code: '131051' }] } },
    });
    expect(undeliveredReason(m)).toBe('notForwarded');
  });

  it('★ malformed errors are no reason, never a rejected message', () => {
    for (const errors of ['nope', [null], [{ code: { x: 1 } }], [42]]) {
      const m = message({ metadata: { unsupported: { providerType: 'unsupported', errors } } });
      expect(undeliveredReason(m)).toBe('notArrived');
    }
  });

  it('★ every other unmodelled type keeps its own line', async () => {
    const revoke = message({
      id: 'x1',
      body: '[revoke message]',
      metadata: { unsupported: { providerType: 'revoke' } },
    });
    expect(undeliveredReason(revoke)).toBeNull();
    await stream([revoke]);
    expect(screen.queryByTestId('undelivered-x1')).toBeNull();
    expect(screen.getByTestId('unsupported-x1')).toBeInTheDocument();
  });

  it('★ an ordinary message is untouched', () => {
    expect(undeliveredReason(message({ body: 'שלום', metadata: null }))).toBeNull();
  });
});

describe('★★ the words', () => {
  const keys = ['phoneOnly', 'notForwarded', 'notArrived'] as const;

  it('exist in en and he', () => {
    for (const messages of [en, he]) {
      for (const key of keys) expect(messages.stream.undelivered[key].length).toBeGreaterThan(0);
    }
  });

  it('Hebrew has no English word and no dash', () => {
    for (const key of keys) {
      expect(he.stream.undelivered[key]).not.toMatch(/[A-Za-z]/);
      expect(he.stream.undelivered[key]).not.toMatch(/[\u2013\u2014]/);
    }
  });

  it('are the sentences Supervisior gave', () => {
    expect(he.stream.undelivered.phoneOnly).toBe('ההודעה הזו מוצגת רק באפליקציית הוואטסאפ בטלפון.');
    expect(he.stream.undelivered.notArrived).toBe(
      'ההודעה הזו לא הגיעה למערכת. אפשר לראות אותה באפליקציית הוואטסאפ.',
    );
  });
});

describe('★★ an album: announced as unsupported, its pictures follow (Supervisior, 2026-11-17)', () => {
  const photo = (id: string, at: string, direction = 'INBOUND') =>
    message({
      id,
      body: '[Image]',
      messageType: 'image',
      mediaUrl: 'https://cdn.example/p.jpg',
      createdAt: at,
      direction,
      metadata: null,
    });
  const announced = unsupported(131051, 'a1');

  it('★★ a picture from the customer within a minute: the soft line, not the full sentence', async () => {
    const after = photo('p1', '2026-11-17T09:00:40.000Z');
    expect(streamUndelivered(announced, [announced, after])).toBe('albumPart');
    await stream([announced, after]);
    expect(screen.getByTestId('undelivered-a1')).toHaveTextContent(he.stream.undelivered.albumPart);
    expect(screen.queryByText(he.stream.undelivered.notForwarded)).toBeNull();
  });

  it('exactly 60 s is inside; 61 s is not', () => {
    expect(streamUndelivered(announced, [announced, photo('p1', '2026-11-17T09:01:00.000Z')])).toBe('albumPart');
    expect(streamUndelivered(announced, [announced, photo('p1', '2026-11-17T09:01:01.000Z')])).toBe(
      'notForwarded',
    );
  });

  it('our own picture, a picture before it, or a text after it: not an album', () => {
    expect(
      streamUndelivered(announced, [announced, photo('p1', '2026-11-17T09:00:10.000Z', 'OUTBOUND')]),
    ).toBe('notForwarded');
    expect(streamUndelivered(announced, [photo('p0', '2026-11-17T08:59:50.000Z'), announced])).toBe(
      'notForwarded',
    );
    const text = message({ id: 't1', body: 'hi', createdAt: '2026-11-17T09:00:10.000Z', metadata: null });
    expect(streamUndelivered(announced, [announced, text])).toBe('notForwarded');
  });

  it('Meta’s own album marker counts when the pictures are not on this page', () => {
    const marked = message({
      id: 'a2',
      metadata: {
        unsupported: {
          providerType: 'unsupported',
          errors: [{ code: 131051 }],
          raw: { type: 'unsupported', unsupported: { type: 'album' } },
        },
      },
    });
    expect(streamUndelivered(marked, [marked])).toBe('albumPart');
  });

  it('a bad time is no album, never a throw', () => {
    const odd = message({ id: 'a3', createdAt: 'not a date', metadata: unsupported(131051).metadata });
    expect(streamUndelivered(odd, [odd, photo('p1', '2026-11-17T09:00:10.000Z')])).toBe('notForwarded');
  });

  it('the soft line in both languages, no English word or dash in Hebrew', () => {
    expect(en.stream.undelivered.albumPart.length).toBeGreaterThan(0);
    expect(he.stream.undelivered.albumPart).not.toMatch(/[A-Za-z\u2013\u2014]/);
  });
});
