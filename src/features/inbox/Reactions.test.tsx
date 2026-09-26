import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { messageSchema, reactionOf, unsupportedType } from '@/api/contracts/inbox';
import en from '@/i18n/messages/en/inbox.json';
import he from '@/i18n/messages/he/inbox.json';

import { MessageStream } from './MessageStream';

/**
 * A customer's reaction, read out of a payload nobody modelled.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE PREMISE, BECAUSE IT IS NOT WHAT THE DESIGN ASSUMES
 * ════════════════════════════════════════════════════════════════════════════
 * There is no reaction table, no column and no handler. A WhatsApp reaction
 * hits the adapter's default branch, so it is stored as a **text message whose
 * body is the literal string `"[reaction message]"`** — which is what an agent
 * reads today — and everything real about it survives only because
 * `webhook.ts:344` persists `metadata.unsupported`.
 *
 * Inbound only is not restraint: `whatsAppOutboundAdapter` has no reaction
 * send, so a picker would have nothing to call.
 */

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'inbox') =>
    createTranslator({ locale: 'en', messages: { inbox: en }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Jerusalem' }),
}));

const message = (over: Record<string, unknown>) =>
  messageSchema.parse({
    id: 'm1',
    direction: 'INBOUND',
    body: '',
    messageType: 'text',
    createdAt: '2026-09-26T09:00:00.000Z',
    ...over,
  });

/** A reaction exactly as it lands: text type, bracketed body, payload aside. */
const reaction = (emoji: string, messageId?: string, id = 'r1') =>
  message({
    id,
    body: '[reaction message]',
    metadata: {
      unsupported: {
        providerType: 'reaction',
        raw: { reaction: { emoji, ...(messageId ? { message_id: messageId } : {}) } },
      },
    },
  });

const stream = async (messages: unknown[]) =>
  render(await MessageStream({ messages: messages as never, channel: 'WHATSAPP' }));

describe('★★ a reaction is not a message, and it arrives as one', () => {
  it('★★ never renders the bracketed placeholder as the customer’s words', async () => {
    /*
     * THE DEFECT. `[reaction message]` is a string the adapter generates, and
     * an agent reading it in a bubble cannot tell whether the customer typed
     * it. It has been what a thumbs-up looks like in this inbox.
     */
    await stream([reaction('👍')]);
    expect(screen.queryByText('[reaction message]')).toBeNull();
    expect(screen.getByTestId('reaction-r1')).toHaveTextContent(/reacted 👍/);
  });

  it('★★ names the message reacted to when it is on this page', async () => {
    const target = message({
      id: 'm5',
      body: 'Your order ships tomorrow',
      externalMessageId: 'wamid.5',
    });
    await stream([target, reaction('❤️', 'wamid.5')]);

    expect(screen.getByTestId('reaction-r1')).toHaveTextContent(/Your order ships tomorrow/);
  });

  it('★★ says "an earlier message" when the target is not on this page', async () => {
    /*
     * The same distinction as a quoted reply: the reaction is real whether or
     * not we are holding the thing it points at, and pretending it is not a
     * reaction would be the larger lie. Reacting to something from last week
     * is the ordinary case, not the edge one.
     */
    await stream([reaction('👍', 'wamid.not-here')]);
    expect(screen.getByTestId('reaction-r1')).toHaveTextContent(/to an earlier message/i);
  });

  it('★★ an empty emoji is Meta taking the reaction BACK, not "no reaction"', async () => {
    /*
     * A removed reaction arrives as the same message with `emoji: ""`. Read
     * as absence it drops the event silently; read as a reaction it prints an
     * empty one. It is its own sentence.
     */
    const removed = reaction('', 'wamid.5');
    expect(reactionOf(removed)).toEqual({ kind: 'removed', toExternalId: 'wamid.5' });

    await stream([removed]);
    const line = screen.getByTestId('reaction-r1');
    expect(line).toHaveAttribute('data-kind', 'removed');
    expect(line).toHaveTextContent(/took their reaction back/i);
  });

  it('★ a reaction with no payload at all is not read as one', async () => {
    // `providerType` without `raw.reaction` is a shape we have not seen. It
    // falls to the unsupported line, which names the type and claims nothing.
    const bare = message({
      id: 'r2',
      body: '[reaction message]',
      metadata: { unsupported: { providerType: 'reaction' } },
    });
    expect(reactionOf(bare)).toBeNull();

    await stream([bare]);
    expect(screen.queryByTestId('reaction-r2')).toBeNull();
    expect(screen.getByTestId('unsupported-r2')).toHaveTextContent(/reaction/);
  });
});

describe('★★ everything else the provider could not give us properly', () => {
  it('★★ names the provider’s type instead of printing a bracketed token', async () => {
    /*
     * `[revoke message]`, `[edit message]` — the adapter's placeholder for
     * every type it does not model. Naming the type is all we can honestly
     * do: unlike a reaction, we have not read these payloads and do not know
     * what happened.
     */
    const revoke = message({
      id: 'x1',
      body: '[revoke message]',
      metadata: { unsupported: { providerType: 'revoke' } },
    });
    expect(unsupportedType(revoke)).toBe('revoke');

    await stream([revoke]);
    expect(screen.queryByText('[revoke message]')).toBeNull();
    expect(screen.getByTestId('unsupported-x1')).toHaveTextContent(/can.t show.*revoke/i);
  });

  it('★ an ordinary message is untouched by any of this', async () => {
    await stream([message({ id: 'm9', body: 'Hello' })]);
    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(screen.queryByTestId('unsupported-m9')).toBeNull();
    expect(screen.queryByTestId('reaction-m9')).toBeNull();
  });
});

describe('★★ both languages', () => {
  it('every reaction sentence exists in en and he', () => {
    for (const messages of [en, he]) {
      for (const key of ['toMessage', 'toEarlier', 'removed'] as const) {
        expect(typeof messages.stream.reaction[key]).toBe('string');
        expect(messages.stream.reaction[key].length).toBeGreaterThan(0);
      }
      expect(typeof messages.stream.unsupported).toBe('string');
    }
  });
});
