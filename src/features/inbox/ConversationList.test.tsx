import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { conversationRowSchema, queueOrder, type ConversationRow } from '@/api/contracts/inbox';
import messages from '@/i18n/messages/en/inbox.json';

import { ConversationList } from './ConversationList';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'inbox') =>
    createTranslator({ locale: 'en', messages: { inbox: messages }, namespace }),
}));

const NOW = new Date('2026-09-25T12:00:00.000Z');

const row = (over: Record<string, unknown> = {}): ConversationRow =>
  conversationRowSchema.parse({
    id: 'c1',
    status: 'OPEN',
    contactName: 'Dana',
    channel: 'WHATSAPP',
    lastMessageAt: '2026-09-25T11:46:00.000Z',
    ...over,
  });

const show = async (rows: readonly ConversationRow[] | null, cap = 50) =>
  render(await ConversationList({ rows, cap, now: NOW }));

describe('★★ the cap is stated, because a silent one teaches a falsehood', () => {
  it('★★ says how many it is showing and that older ones are not reachable', async () => {
    /*
     * The endpoint paginates by offset, and on a recency-ordered list a new
     * message between pages makes an agent see a duplicate and SILENTLY SKIP
     * a row. A skipped conversation is somebody waiting who never appears.
     *
     * So there is one page, and it says so. A list that stops at N without
     * saying anything teaches an agent that N is all there is.
     */
    await show([row()], 50);
    const cap = screen.getByTestId('queue-cap');
    expect(cap).toHaveTextContent(/50 most recent/i);
    expect(cap).toHaveTextContent(/aren't reachable from here yet/i);
  });
});

describe('★★ rows the ordering cannot place are shown, not sunk', () => {
  it('★★ puts a null `lastMessageAt` in its own group rather than the floor', async () => {
    /*
     * `lastMessageAt` is a denormalised cache maintained by convention at
     * ten call sites, and writers bypass it — one conversation on dev is
     * open with two real messages and no value.
     *
     * Sorted naively it sinks to the bottom of a recency list and is never
     * seen: the same defect as the pagination skip. Sorted to the top it
     * would claim to be the most recent, which it does not know either.
     */
    await show([row({ id: 'dated' }), row({ id: 'lost', lastMessageAt: null })]);

    expect(screen.getByTestId('undated-lost')).toBeInTheDocument();
    expect(screen.queryByTestId('conversation-lost')).toBeNull();
    expect(screen.getByTestId('queue-undated')).toHaveTextContent(
      /can't place it in the order above/i,
    );
  });

  it('★ an unparseable timestamp is undated too, never sorted as though valid', () => {
    // `Date.parse` of rubbish is NaN, and a NaN comparator silently leaves
    // the array in whatever order it arrived — an ordering nobody chose,
    // presented as one somebody did.
    const { dated, undated } = queueOrder([row({ id: 'bad', lastMessageAt: 'soon' })]);
    expect(dated).toHaveLength(0);
    expect(undated).toHaveLength(1);
  });

  it('says nothing at all when every row is dated', async () => {
    await show([row()]);
    expect(screen.queryByTestId('queue-undated')).toBeNull();
  });

  it('orders the dated rows newest first', () => {
    const { dated } = queueOrder([
      row({ id: 'old', lastMessageAt: '2026-09-25T09:00:00.000Z' }),
      row({ id: 'new', lastMessageAt: '2026-09-25T11:00:00.000Z' }),
    ]);
    expect(dated.map((r) => r.id)).toEqual(['new', 'old']);
  });
});

describe('★ waiting time, and the row that has none', () => {
  it('ages a dated row', async () => {
    await show([row()]);
    expect(screen.getByTestId('waiting-c1')).toHaveTextContent('14m');
  });

  it('★★ shows no waiting time at all for an undated row, rather than 0m', async () => {
    /*
     * Zero would put a conversation nobody can age alongside the freshest
     * thing in the queue — a fabricated recency, the same shape as the 0s
     * reply average that made the idlest person fastest.
     */
    await show([row({ id: 'lost', lastMessageAt: null })]);
    expect(screen.queryByTestId('waiting-lost')).toBeNull();
    expect(screen.getByTestId('undated-lost')).not.toHaveTextContent(/0m/);
  });

  it('a failed read is not an empty queue', async () => {
    await show(null);
    expect(screen.getByTestId('queue-unavailable')).toHaveTextContent(/couldn't read/i);
  });

  it('an empty queue says nothing is waiting', async () => {
    await show([]);
    expect(screen.getByTestId('queue-empty')).toHaveTextContent(/nothing is waiting/i);
  });
});
