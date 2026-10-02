import { readFileSync } from 'node:fs';

import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { commerceContextSchema } from '@/api/contracts/customer-orders';
import { conversationRowSchema } from '@/api/contracts/inbox';
import channels from '@/i18n/messages/en/channels.json';
import inbox from '@/i18n/messages/en/inbox.json';

import { OrdersChip } from './ConversationDetail';
import { ConversationHeader } from './ConversationHeader';
import { initials } from './initials';

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
    // One line in 02's subline, so the line says the fact and the reason is
    // the tooltip — still there, and still not "0m".
    const unknown = screen.getByTestId('conversation-waiting-unknown');
    expect(unknown).toHaveTextContent(/wait unknown/i);
    expect(unknown).toHaveAttribute('title', expect.stringMatching(/can’t say how long/i));
  });
});

describe('★★ 02’s chip — "Returning · 6 orders" — from the count we already had', () => {
  const ctx = (raw: unknown) => commerceContextSchema.parse(raw);
  /*
   * The chip streams in beside the name (`OrdersChip`, in a `<Suspense>` the
   * header carries as its `chip` slot), so it is rendered the way the page
   * does: the header with the chip in it.
   */
  const showWith = async (orders: ReturnType<typeof ctx> | null) =>
    render(
      await ConversationHeader({
        conversation: row(),
        now: NOW,
        chip: await OrdersChip({
          detail: Promise.resolve({
            messages: null,
            timeline: null,
            orders,
            copilot: { state: 'unavailable' },
          }),
        }),
      }),
    );

  it('★★ more than one order is "Returning", with the count', async () => {
    await showWith(ctx({ state: 'ok', data: { summary: { orderCount: 6 } } }));
    expect(screen.getByTestId('conversation-orders')).toHaveTextContent('Returning · 6 orders');
  });

  it('★ one order is a count, not "Returning"', async () => {
    await showWith(ctx({ state: 'ok', summary: { orderCount: 1 } }));
    const chip = screen.getByTestId('conversation-orders');
    expect(chip).toHaveTextContent('1 order');
    expect(chip).not.toHaveTextContent(/returning/i);
  });

  it('⚠⚠ no chip for 0 — the contract defaults the count to 0, so 0 may mean "not sent"', async () => {
    await showWith(ctx({ state: 'ok', data: { summary: {} } }));
    expect(screen.queryByTestId('conversation-orders')).toBeNull();
  });

  it('⚠ and none when the read was not `ok`, or did not happen', async () => {
    await showWith(ctx({ state: 'no_orders', summary: { orderCount: 3 } }));
    expect(screen.queryByTestId('conversation-orders')).toBeNull();
    await showWith(null);
    expect(screen.queryByTestId('conversation-orders')).toBeNull();
  });

  it('★ the avatar carries the initials, as 02’s 34px disc does', async () => {
    const { container } = await showWith(null);
    expect(container.querySelector('header [aria-hidden="true"]')?.textContent).toBe(
      initials(row().customerName),
    );
  });
});

describe('★★ Wave 3 geometry, read from the stylesheet', () => {
  const css = readFileSync('src/features/inbox/Inbox.module.css', 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  // A rule of its OWN — not a selector list's second entry, which shares the
  // first one's declarations and would answer for a rule that may not exist.
  const rule = (selector: string) =>
    new RegExp(`(?<!,\\s*)\\.${selector}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';

  it('★★ the header is ONE row across the panel, on the panel — not a card', () => {
    const bar = rule('openBar');
    expect(bar).toMatch(/padding:\s*var\(--space-16\) 22px/);
    expect(bar).toMatch(/border-block-end:\s*1px solid var\(--border-subtle\)/);
    expect(bar).toMatch(/align-items:\s*center/);
    expect(bar).not.toMatch(/background-color|border-radius|flex-direction:\s*column/);
    expect(bar).toMatch(/line-height:\s*normal/);
  });

  it('⚠ the name row is reserved at the chip’s 18 — it streams in later, and must not move anything', () => {
    expect(rule('openNameRow')).toMatch(/min-block-size:\s*18px/);
  });

  it('★ the verbs sit at the row’s end, and only Resolve is filled', () => {
    expect(rule('verbs')).toMatch(/margin-inline-start:\s*auto/);
    expect(rule('verbButton')).toMatch(/border:\s*1px solid var\(--border-default\)/);
    expect(rule('verbButtonPrimary')).toMatch(/background-color:\s*var\(--action-base\)/);
  });

  it('★★ the composer is a white card that grows with what is typed', () => {
    const card = rule('composer');
    expect(card).toMatch(/background-color:\s*var\(--panel-field\)/);
    expect(card).toMatch(/border-radius:\s*var\(--radius-card\)/);
    expect(rule('composerInput')).toMatch(/field-sizing:\s*content/);
    expect(rule('composerSend')).toMatch(/background-color:\s*var\(--action-send\)/);
  });
});
