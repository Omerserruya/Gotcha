import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { conversationRowSchema } from '@/api/contracts/inbox';
import channels from '@/i18n/messages/en/channels.json';
import inbox from '@/i18n/messages/en/inbox.json';

import { ConversationHeader } from './ConversationHeader';

/**
 * Screen 02's header — the three facts that were nowhere on the screen.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE CONVERSATION COLUMN BEGAN AT THE VERBS AND WENT STRAIGHT INTO MESSAGES
 * ════════════════════════════════════════════════════════════════════════════
 * So an agent arriving from the queue, or from a link, read a wall of text with
 * no statement of who it is with, on what channel, or how long they have been
 * waiting. Every field was already loaded for the queue row beside it — the
 * screen simply said none of it once the row was opened.
 */

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'inbox' | 'channels') =>
    createTranslator({ locale: 'en', messages: { inbox, channels }, namespace }),
}));

const NOW = new Date('2026-09-27T12:00:00.000Z');

const row = (over: Record<string, unknown> = {}) =>
  conversationRowSchema.parse({
    id: 'c1',
    status: 'OPEN',
    customerName: 'Avery Stone',
    customerExternalId: '+972525401686',
    channel: 'WHATSAPP',
    lastMessageAt: '2026-09-27T11:30:00.000Z',
    ...over,
  });

const show = async (over: Record<string, unknown> = {}) =>
  render(await ConversationHeader({ conversation: row(over), now: NOW }));

describe('★★ who this is, on what channel, and how long they have waited', () => {
  it('★★ names the customer and isolates the name', async () => {
    /*
     * A Hebrew name in an English page reorders the line around it without
     * `bdi` — the defect that shipped on five other surfaces and was found only
     * by a person looking at a screenshot.
     */
    await show({ customerName: 'דנה כהן' });
    const who = screen.getByTestId('conversation-who');
    expect(who).toHaveTextContent('דנה כהן');
    expect(who.querySelector('bdi')).toHaveAttribute('dir', 'auto');
  });

  it('★★ says plainly that there is no name, rather than inventing "Someone"', async () => {
    /*
     * A first message from a number nobody has met is an ordinary state. The
     * handle below identifies them, so the heading tells the truth — and every
     * queue row reading "Someone" was this week's most visible defect.
     */
    await show({ customerName: null });
    expect(screen.getByTestId('conversation-who')).toHaveTextContent(/no name/i);
  });

  it('★★ names the channel, never its enum', async () => {
    await show({ channel: 'SHOPIFY_LIVE_CHAT' });
    const facts = screen.getByTestId('conversation-facts');
    expect(facts).toHaveTextContent('Shopify live chat');
    expect(facts).not.toHaveTextContent('SHOPIFY_LIVE_CHAT');
  });

  it('carries the handle, which is what tells two unnamed people apart', async () => {
    await show({ customerName: null });
    expect(screen.getByTestId('conversation-facts')).toHaveTextContent('+972525401686');
  });

  it('★ names the status rather than showing it', async () => {
    await show({ status: 'WAITING' });
    const facts = screen.getByTestId('conversation-facts');
    expect(facts).toHaveTextContent('Waiting on them');
    expect(facts).not.toHaveTextContent('WAITING');
  });

  it('says how long they have waited', async () => {
    await show({ lastMessageAt: '2026-09-27T11:30:00.000Z' });
    expect(screen.getByTestId('conversation-waiting')).toHaveTextContent('30m');
  });

  it('★★ changes unit rather than counting hours past a day', async () => {
    /*
     * The third screen to need this. A scale that ends at the largest unit
     * somebody happened to need produced `47061m`, `1444h` and a three-digit
     * hour count on three different screens.
     */
    await show({ lastMessageAt: '2026-07-27T12:00:00.000Z' });
    const waiting = screen.getByTestId('conversation-waiting');
    expect(waiting).toHaveTextContent(/62 days/);
    expect(waiting.textContent).not.toMatch(/\d{4,}/);
  });

  it('★★ says we cannot tell, rather than showing 0m, when there is no last message', async () => {
    /*
     * `lastMessageAt` is a denormalised cache maintained by convention, so its
     * absence is real and common. "0m" would sort it as the freshest thing on
     * the screen and read as just-arrived — the reassuring direction.
     */
    await show({ lastMessageAt: null });
    expect(screen.queryByTestId('conversation-waiting')).toBeNull();
    expect(screen.getByTestId('conversation-waiting-unknown')).toHaveTextContent(
      /can’t say how long/i,
    );
  });
});
