import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { messageSchema, type InboxMessage } from '@/api/contracts/inbox';
import messages from '@/i18n/messages/en/inbox.json';

import { MessageStream } from './MessageStream';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'inbox') =>
    createTranslator({ locale: 'en', messages: { inbox: messages }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Jerusalem' }),
}));

const message = (over: Record<string, unknown> = {}): InboxMessage =>
  messageSchema.parse({
    id: 'm1',
    direction: 'INBOUND',
    body: 'Is the order still coming Thursday?',
    createdAt: '2026-09-25T09:14:00.000Z',
    ...over,
  });

const show = async (list: readonly InboxMessage[] | null, channel: string | null = 'WHATSAPP') =>
  render(await MessageStream({ messages: list, channel }));

describe('★★ a reply whose quote we never stored is still a reply', () => {
  it('★★ says so rather than showing an ordinary message', async () => {
    /*
     * `replyToMessageId` can fail to resolve — the quoted message may
     * predate GOTCHA or have been deleted — while `replyToExternalId` is the
     * provider's and survives. Rendering it plain loses the fact that the
     * customer was answering something, which is often what makes the
     * message legible at all.
     */
    await show([message({ replyToExternalId: 'wamid.x' })]);
    expect(screen.getByTestId('quoted-missing-m1')).toHaveTextContent(
      /earlier message we don't have/i,
    );
  });

  it('says nothing extra when the quote resolved', async () => {
    await show([message({ replyToExternalId: 'wamid.x', replyToMessageId: 'm0' })]);
    expect(screen.queryByTestId('quoted-missing-m1')).toBeNull();
  });
});

describe('★★ the voice note we cannot read out', () => {
  it('★★ says it plainly instead of implying a failed transcript', async () => {
    /*
     * The design says "Read what she said". Nothing transcribes audio: the
     * worker's only audio-specific line is a filename extension, and the
     * Deepgram credential exists without a client.
     *
     * A player beside an empty transcript area would let an agent conclude
     * the transcription failed and might work next time. Saying we cannot
     * read it is the difference between a gap and a fault.
     */
    await show([message({ messageType: 'audio', body: '' })]);
    const note = screen.getByTestId('voice-m1');
    expect(note).toHaveTextContent(/can't read it out/i);
    expect(note).toHaveTextContent(/you'll need to listen/i);
  });
});

describe('★★ an unconstrained type gets no label we would be guessing at', () => {
  it('★★ sets no data-type for a value nobody has accounted for', async () => {
    /*
     * `messageType` is a free String. A styling hook that said "system" for
     * the next type somebody writes would mislabel it silently — the
     * `KnowledgeDocument.status` trap in a DOM attribute.
     */
    await show([message({ messageType: 'shopify_product' })]);
    expect(screen.getByTestId('message-m1')).not.toHaveAttribute('data-type');
  });

  it('★ still shows the body of a message it cannot classify', async () => {
    // The message happened. Hiding it would shorten the conversation.
    await show([message({ messageType: 'voice_final', body: 'I said yes' })]);
    expect(screen.getByTestId('message-m1')).toHaveTextContent('I said yes');
  });

  it('★★ names a RECOGNISED type it cannot draw, not just an unknown one', async () => {
    /*
     * The hole this test found. `location` is in KNOWN_MESSAGE_TYPES and
     * has no rendering branch, so keying the fallback on "unrecognised"
     * left it as a timestamp in an empty bubble. Recognised-and-unhandled
     * is a third case and it looked like the handled one.
     */
    await show([message({ messageType: 'location', body: '' })]);
    expect(screen.getByTestId('unknown-m1')).toHaveTextContent(/can.t show yet/i);
  });

  it('★ and an unrecognised type with no body lands there too', async () => {
    await show([message({ messageType: 'shopify_product', body: '' })]);
    expect(screen.getByTestId('unknown-m1')).toHaveTextContent(/can.t show yet/i);
  });

  it('labels the types it can account for', async () => {
    await show([message({ messageType: 'image', body: '' })]);
    expect(screen.getByTestId('message-m1')).toHaveAttribute('data-type', 'image');
    expect(screen.getByTestId('media-m1')).toHaveTextContent(/a photo/i);
  });
});

describe('★★ the read receipt belongs to the customer', () => {
  it('★★ labels it as theirs, never as the agent having seen it', async () => {
    /*
     * `Message.readAt` is the CUSTOMER's receipt. The same word means the
     * agent's queue elsewhere in this product, and collapsing them would
     * empty a queue as customers open their phones.
     */
    await show([message({ id: 'out', direction: 'OUTBOUND', readAt: '2026-09-25T09:20:00.000Z' })]);
    const read = screen.getByTestId('read-out');
    expect(read).toHaveTextContent(/read/i);
    // And never phrased as the agent's state.
    expect(read).not.toHaveTextContent(/unread|you|seen by you/i);
  });

  it('★ never shows a receipt on an inbound message', async () => {
    // A receipt on something the customer sent would be claiming WE read it,
    // which is the agent-unread fact that does not exist.
    await show([message({ readAt: '2026-09-25T09:20:00.000Z' })]);
    expect(screen.queryByTestId('read-m1')).toBeNull();
  });
});

describe('★ what the design draws and the stream does not', () => {
  it('★★ renders no reaction, no intent edge and no photo analysis', async () => {
    /*
     * Reactions have no model. Per-message intent does not persist — it is
     * per CONVERSATION — so the 3px edge has no data. And nothing looks at
     * an image, so "GOTCHA saw damage in this photo" is aspirational.
     */
    const { container } = await show([message({ messageType: 'image' })]);
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/react|👍|saw damage|detected|intent/i);
    expect(container.querySelector('[data-intent]')).toBeNull();
  });

  it('a failed read is not an empty conversation', async () => {
    await show(null);
    expect(screen.getByTestId('stream-unavailable')).toHaveTextContent(/couldn't read/i);
  });
});

describe('★★ a message the customer never received', () => {
  /*
   * ════════════════════════════════════════════════════════════════════════════
   * PENDING AND FAILED WERE THE SAME RENDERING, AND THE RENDERING WAS SILENCE
   * ════════════════════════════════════════════════════════════════════════════
   * The stream read `readAt`, then `deliveredAt`, then showed nothing. So an
   * outbound reply the provider rejected looked exactly like one sent a second
   * ago — and the operator, told nothing, stops watching.
   *
   * `Message.status` was on the wire the whole time and our `z.object` stripped
   * it. These are the assertions that make the difference visible.
   */
  it('★★ says a failed message did not send, and that nobody received it', async () => {
    await show([message({ id: 'm1', direction: 'OUTBOUND', status: 'FAILED' })]);
    expect(screen.getByTestId('failed-m1')).toHaveTextContent(/did not send/i);
    expect(screen.getByTestId('failed-m1')).toHaveTextContent(/never received it/i);
  });

  it('★★ a failure outranks a delivery timestamp recorded before it', async () => {
    await show([
      message({
        id: 'm1',
        direction: 'OUTBOUND',
        status: 'FAILED',
        deliveredAt: '2026-09-27T10:00:00.000Z',
      }),
    ]);
    expect(screen.getByTestId('failed-m1')).toBeInTheDocument();
    expect(screen.queryByTestId('delivered-m1')).toBeNull();
  });

  it('★★ distinguishes still-sending from handed-to-the-channel', async () => {
    /*
     * Two different promises. `PENDING` is ours — the row is in a queue we own.
     * `SENT` means the provider has it and has not confirmed delivery, which is
     * as far as our knowledge goes and is therefore what it says.
     */
    await show([
      message({ id: 'm1', direction: 'OUTBOUND', status: 'PENDING' }),
      message({ id: 'm2', direction: 'OUTBOUND', status: 'SENT' }),
    ]);
    expect(screen.getByTestId('pending-m1')).toHaveTextContent(/still sending/i);
    expect(screen.getByTestId('sent-m2')).toHaveTextContent(/not confirmed delivered/i);
  });

  it('★★ says it cannot tell, rather than falling through to silence', async () => {
    /*
     * A status from a newer platform than this catalogue. Silence here is what
     * hid every failure, so an unrecognised value says so out loud — the safe
     * default for "did this arrive" is no.
     */
    await show([message({ id: 'm1', direction: 'OUTBOUND', status: 'SOMETHING_NEW' })]);
    expect(screen.getByTestId('delivery-unknown-m1')).toHaveTextContent(/can’t tell/i);
  });

  it('★★ marks nothing on an inbound message', async () => {
    await show([message({ id: 'm1', direction: 'INBOUND', status: 'FAILED' })]);
    expect(screen.queryByTestId('failed-m1')).toBeNull();
    expect(screen.queryByTestId('delivery-unknown-m1')).toBeNull();
  });

  it('keeps the read receipt as the strongest state', async () => {
    await show([
      message({
        id: 'm1',
        direction: 'OUTBOUND',
        status: 'SENT',
        readAt: '2026-09-27T10:00:00.000Z',
      }),
    ]);
    expect(screen.getByTestId('read-m1')).toBeInTheDocument();
  });
});
