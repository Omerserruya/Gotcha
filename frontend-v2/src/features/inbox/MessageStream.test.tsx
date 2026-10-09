import { readFileSync } from 'node:fs';

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
     * `replyToMessageId` can fail to resolve - the quoted message may
     * predate GOTCHA or have been deleted - while `replyToExternalId` is the
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
     * the next type somebody writes would mislabel it silently - the
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
     * The hole this test found. `location` was in KNOWN_MESSAGE_TYPES with
     * no rendering branch, so keying the fallback on "unrecognised" left it
     * as a timestamp in an empty bubble. Recognised-and-unhandled is a third
     * case and it looked like the handled one. (Location is drawn since
     * 2026-10-09; `interactive` is still recognised and undrawn.)
     */
    await show([message({ messageType: 'interactive', body: '' })]);
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
     * Reactions have no model. Per-message intent does not persist - it is
     * per CONVERSATION - so the 3px edge has no data. And nothing looks at
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
   * ago - and the operator, told nothing, stops watching.
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
     * Two different promises. `PENDING` is ours - the row is in a queue we own.
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
     * hid every failure, so an unrecognised value says so out loud - the safe
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

describe('★★ Wave 4 - 02’s bubble, and its time line under it', () => {
  it('★★ the time line is OUTSIDE the bubble, as 02 draws it', async () => {
    await show([message()]);
    const item = screen.getByTestId('message-m1');
    const time = item.querySelector('time');
    expect(time).not.toBeNull();
    // The bubble is the item's first child; the time must not be inside it.
    expect(item.firstElementChild?.contains(time)).toBe(false);
  });

  it('⚠ the time is 24-hour in the configured zone - 02’s `09:12`, not "12:14 PM"', async () => {
    await show([message({ createdAt: '2026-09-25T09:14:00.000Z' })]);
    expect(screen.getByTestId('message-m1').querySelector('time')?.textContent).toBe('12:14');
  });

  it('★ an AI employee’s reply names it on the time line', async () => {
    await show([message({ direction: 'OUTBOUND', senderName: 'Support AI' })]);
    expect(screen.getByTestId('sender-m1')).toHaveTextContent('Support AI');
  });

  it('⚠⚠ a colleague’s LOGIN EMAIL is never printed as a name', async () => {
    await show([message({ direction: 'OUTBOUND', senderName: 'dana@shop.co.il' })]);
    expect(screen.queryByTestId('sender-m1')).toBeNull();
    expect(screen.getByTestId('message-m1').textContent).not.toContain('@');
  });

  it('★ and the customer’s own messages carry no sender - the header names them', async () => {
    await show([message({ direction: 'INBOUND', senderName: 'Dana Cohen' })]);
    expect(screen.queryByTestId('sender-m1')).toBeNull();
  });
});

describe('★★ the quote travels with the reply - drawn even when it is not on the page', () => {
  const replying = (replyTo: Record<string, unknown>) =>
    message({ replyToMessageId: 'm0', replyTo: { id: 'm0', ...replyTo } });

  it('★★ says who said it and what, inside the bubble', async () => {
    await show([replying({ direction: 'INBOUND', body: 'Where is my parcel?' })]);
    const quote = screen.getByTestId('quote-m1');
    expect(quote).toHaveTextContent('Customer');
    expect(quote).toHaveTextContent('Where is my parcel?');
    expect(screen.getByTestId('message-m1').firstElementChild?.contains(quote)).toBe(true);
  });

  it('★ our own quoted reply names the AI employee, or "Your team" for a person', async () => {
    await show([replying({ direction: 'OUTBOUND', body: 'On its way', senderName: 'Support AI' })]);
    expect(screen.getByTestId('quote-m1')).toHaveTextContent('Support AI');
  });

  it('⚠ and never a colleague’s email', async () => {
    await show([replying({ direction: 'OUTBOUND', body: 'On its way', senderName: 'a@b.co' })]);
    expect(screen.getByTestId('quote-m1')).toHaveTextContent('Your team');
    expect(screen.getByTestId('quote-m1').textContent).not.toContain('@');
  });

  it('★ a quoted photo with no text says so rather than drawing an empty line', async () => {
    await show([replying({ direction: 'INBOUND', body: null, messageType: 'image' })]);
    expect(screen.getByTestId('quote-m1')).toHaveTextContent('A message with no text');
  });
});

describe('★ 02’s bubble geometry, read from the stylesheet', () => {
  const css = readFileSync('src/features/inbox/Inbox.module.css', 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  const block = (selector: string) =>
    new RegExp(`(?:^|\\n)\\s*${selector.replace(/[.[\]'()=]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(
      css,
    )?.[1] ?? '';

  it('★★ inbound is white and bordered; its sharp corner is the sender’s', () => {
    const bubble = block('.bubble');
    expect(bubble).toMatch(/background-color:\s*var\(--panel-field\)/);
    expect(bubble).toMatch(/border:\s*1px solid var\(--border-default\)/);
    expect(bubble).toMatch(/border-end-start-radius:\s*var\(--space-4\)/);
  });

  it('★★ outbound is 02’s dark bubble, sharp at the other corner', () => {
    const out = block(".message[data-direction='OUTBOUND'] .bubble");
    expect(out).toMatch(/background-color:\s*var\(--action-base\)/);
    expect(out).toMatch(/border-end-end-radius:\s*var\(--space-4\)/);
    // 02: no border. A transparent 1px still made the box 2px larger.
    expect(out).toMatch(/(?:^|\n)\s*border:\s*0;/);
  });

  it('⚠ the stream’s lines are `normal`, and only message text is 1.5', () => {
    expect(block('.stream')).toMatch(/line-height:\s*normal/);
    expect(block('.bubble')).toMatch(/line-height:\s*1\.5/);
  });
});

describe('★ every message offers Reply, describing itself to the composer', () => {
  it('★★ the button names the message: who said it and a line of it', async () => {
    await show([message({ direction: 'INBOUND', body: 'Where is my parcel?' })]);
    const heard: unknown[] = [];
    const listen = (event: Event) => heard.push((event as CustomEvent).detail);
    window.addEventListener('gotcha:reply-to', listen);
    screen.getByTestId('reply-m1').click();
    window.removeEventListener('gotcha:reply-to', listen);
    expect(heard).toEqual([{ id: 'm1', who: 'Customer', preview: 'Where is my parcel?' }]);
  });

  it('⚠ and our own reply is attributed without a colleague’s email', async () => {
    await show([message({ direction: 'OUTBOUND', body: 'On its way', senderName: 'a@b.co' })]);
    const heard: Array<{ who: string }> = [];
    const listen = (event: Event) => heard.push((event as CustomEvent).detail);
    window.addEventListener('gotcha:reply-to', listen);
    screen.getByTestId('reply-m1').click();
    window.removeEventListener('gotcha:reply-to', listen);
    expect(heard[0]?.who).toBe('Your team');
  });
});

describe('★★ media in the stream, as 02 draws it - never "A photo." when the photo is here', () => {
  it('a photo: the picture itself, opening whole in a new tab; the adapter’s "[Image]" not printed', async () => {
    await show([
      message({ messageType: 'image', mediaUrl: '/api/uploads/a.jpg', body: '[Image]' }),
    ]);
    const photo = screen.getByTestId('photo-m1');
    expect(photo).toHaveAttribute('href', '/api/uploads/a.jpg');
    expect(photo).toHaveAttribute('target', '_blank');
    expect(photo.querySelector('img')).toHaveAttribute('src', '/api/uploads/a.jpg');
    expect(screen.getByTestId('message-m1')).not.toHaveTextContent('[Image]');
    expect(screen.queryByTestId('unknown-m1')).toBeNull();
  });

  it('a caption the customer wrote stays', async () => {
    await show([
      message({
        messageType: 'image',
        mediaUrl: '/api/uploads/a.jpg',
        body: 'Look at the corner of the box.',
      }),
    ]);
    expect(screen.getByTestId('message-m1')).toHaveTextContent('Look at the corner of the box.');
  });

  it('a voice note plays - and still says it can’t be read out', async () => {
    await show([
      message({ messageType: 'audio', mediaUrl: '/api/uploads/v.ogg', body: '[Voice message]' }),
    ]);
    expect(screen.getByTestId('audio-m1').querySelector('audio')).toHaveAttribute(
      'src',
      '/api/uploads/v.ogg',
    );
    expect(screen.getByTestId('voice-m1')).toHaveTextContent(/can't read it out/i);
  });

  it('video with its controls; a file by its name, to download', async () => {
    const one = await show([
      message({ messageType: 'video', mediaUrl: '/api/uploads/c.mp4', body: '' }),
    ]);
    expect(screen.getByTestId('video-m1')).toHaveAttribute('controls');
    one.unmount();
    await show([
      message({
        messageType: 'document',
        mediaUrl: '/api/uploads/t.pdf',
        fileName: 'Terms.pdf',
        body: 'Terms.pdf',
      }),
    ]);
    const file = screen.getByTestId('file-m1');
    expect(file).toHaveTextContent('Terms.pdf');
    expect(file).toHaveAttribute('download', 'Terms.pdf');
    // The file's own name as caption is the label already - not printed twice.
    expect(screen.getByTestId('message-m1').textContent?.match(/Terms\.pdf/g)).toHaveLength(1);
  });

  it('★ media that could not be fetched says so - never a blank bubble or "[Document]"', async () => {
    await show([
      message({
        messageType: 'document',
        mediaUrl: null,
        body: '[Document]',
        metadata: { mediaError: 'expired' },
      }),
    ]);
    expect(screen.getByTestId('media-gone-m1')).toHaveTextContent("couldn't be fetched");
    expect(screen.getByTestId('message-m1')).not.toHaveTextContent('[Document]');
  });

  it('★ an address that is not https or this host is never followed', async () => {
    await show([message({ messageType: 'image', mediaUrl: 'javascript:alert(1)', body: '' })]);
    expect(screen.queryByTestId('photo-m1')).toBeNull();
    expect(screen.getByTestId('media-m1')).toHaveTextContent(/a photo/i);
  });

  it('a shared contact: who, and the number to call or write', async () => {
    await show([
      message({
        messageType: 'contact',
        body: 'Avi',
        metadata: {
          contacts: [
            {
              name: 'Avi',
              organization: 'Carrier',
              phones: [{ number: '+972 50-123 4567', waId: '972501234567' }],
            },
          ],
        },
      }),
    ]);
    const card = screen.getByTestId('contacts-m1');
    expect(card).toHaveTextContent('AviCarrier');
    expect(card.querySelector('a[href="tel:+972501234567"]')).not.toBeNull();
    expect(card.querySelector('a[href="https://wa.me/972501234567"]')).not.toBeNull();
    // The name is the card's head - not printed above it again.
    expect(screen.getByTestId('message-m1').textContent?.match(/Avi/g)).toHaveLength(1);
  });

  it('a sticker is drawn small', async () => {
    await show([
      message({
        messageType: 'sticker',
        mediaUrl: 'https://cdn.example/s.webp',
        body: '[Sticker]',
      }),
    ]);
    expect(screen.getByTestId('photo-m1').querySelector('img')).toHaveAttribute(
      'src',
      'https://cdn.example/s.webp',
    );
  });
});

describe('★ media corrections (measured in a preview)', () => {
  it('WhatsApp’s `contacts` (plural): the name is the card’s head, not printed again', async () => {
    await show([
      message({
        messageType: 'contacts',
        body: 'Dana Cohen',
        metadata: { contacts: [{ name: 'Dana Cohen', phones: [{ number: '+972501234567' }] }] },
      }),
    ]);
    expect(screen.getByTestId('message-m1').textContent?.match(/Dana Cohen/g)).toHaveLength(1);
  });

  it('a voice note is ONE control: the disc plays; no browser controls beside it', async () => {
    await show([message({ messageType: 'audio', mediaUrl: '/api/uploads/v.ogg', body: '' })]);
    const voice = screen.getByTestId('audio-m1');
    expect(screen.getByTestId('voice-play-m1')).toHaveAccessibleName('Play the voice note');
    expect(voice.querySelector('audio')).not.toHaveAttribute('controls');
    expect(voice).toHaveTextContent('0:00');
  });
});

describe('★★ a shared location is a place and a way to the map - never "[Location: …]" (2026-10-09)', () => {
  it('★ from metadata (Backend 11094abb): the name, the address, the provider’s link as given', async () => {
    await show([
      message({
        messageType: 'location',
        body: '[Shared location: Sarona Market, Kalman Magen 3 (32.0717, 34.7867)]',
        metadata: {
          location: {
            latitude: 32.0717,
            longitude: 34.7867,
            name: 'Sarona Market',
            address: 'Kalman Magen 3, Tel Aviv',
            url: 'https://maps.app.goo.gl/abc',
          },
        },
      }),
    ]);
    const card = screen.getByTestId('location-m1');
    expect(card).toHaveTextContent('Sarona Market');
    expect(card).toHaveTextContent('Kalman Magen 3, Tel Aviv');
    const map = screen.getByTestId('location-m1-map');
    expect(map).toHaveAttribute('href', 'https://maps.app.goo.gl/abc');
    expect(map).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(map).toHaveTextContent('Open in map');
    expect(screen.getByTestId('message-m1')).not.toHaveTextContent('[Shared location');
    expect(screen.queryByTestId('unknown-m1')).toBeNull();
  });

  it('★ the live row from dev: the old body, read as a point - the bracket text never shown', async () => {
    await show([message({ messageType: 'location', body: '[Location: 32.0853, 34.7818]' })]);
    const card = screen.getByTestId('location-m1');
    expect(card).toHaveTextContent('Shared location');
    expect(card).toHaveTextContent('32.0853, 34.7818');
    expect(screen.getByTestId('location-m1-map')).toHaveAttribute(
      'href',
      'https://www.google.com/maps?q=32.0853,34.7818',
    );
    expect(screen.getByTestId('message-m1')).not.toHaveTextContent('[Location');
  });

  it('a link that is not https is not followed - the map is built from the point', async () => {
    await show([
      message({
        messageType: 'location',
        body: '',
        metadata: { location: { latitude: 1, longitude: 2, url: 'javascript:alert(1)' } },
      }),
    ]);
    expect(screen.getByTestId('location-m1-map')).toHaveAttribute(
      'href',
      'https://www.google.com/maps?q=1,2',
    );
  });

  it('★ stored as TEXT when its point was bad (the adapter’s `[Shared location]`): still not raw', async () => {
    await show([message({ messageType: 'text', body: '[Shared location]' })]);
    expect(screen.getByTestId('location-m1')).toHaveTextContent(/its place didn.t come through/);
    expect(screen.getByTestId('message-m1')).not.toHaveTextContent('[Shared location]');
  });

  it('a location with no point is said in words, not printed raw', async () => {
    await show([message({ messageType: 'location', body: '[Shared location]' })]);
    expect(screen.getByTestId('location-m1')).toHaveTextContent(/its place didn.t come through/);
    expect(screen.getByTestId('message-m1')).not.toHaveTextContent('[Shared location]');
  });

  it('a customer who types brackets about a place is still their own words', async () => {
    await show([message({ messageType: 'text', body: 'my location: [home]' })]);
    expect(screen.queryByTestId('location-m1')).toBeNull();
    expect(screen.getByTestId('message-m1')).toHaveTextContent('my location: [home]');
  });
});
