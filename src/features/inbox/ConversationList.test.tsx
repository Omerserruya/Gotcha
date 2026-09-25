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

const show = async (
  rows: readonly ConversationRow[] | null,
  cap = 50,
  hasMore = false,
  undatedCount?: number,
) => render(await ConversationList({ rows, cap, now: NOW, hasMore, undatedCount }));

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
    await show([row()], 50, true);
    expect(screen.getByTestId('queue-cap')).toHaveTextContent(/50 most recent/i);
  });

  it('★ says so plainly when there is nothing beyond this page', async () => {
    await show([row()], 50, false);
    expect(screen.getByTestId('queue-cap')).toHaveTextContent(/that's all of them/i);
  });
});

describe('★★ the undated group is per PAGE, because nulls sort last', () => {
  /*
   * ════════════════════════════════════════════════════════════════════════
   * THE DEFECT THE KEYSET ENDPOINT EXPOSED IN MY OWN WORK.
   * ════════════════════════════════════════════════════════════════════════
   * The server orders `{ lastMessageAt: desc, nulls: last }`, so every
   * undated row is at the very END of the whole queue. On a tenant with
   * more conversations than one page holds, the group I built to make a
   * hidden problem visible is itself empty on every page but the last —
   * hidden by the ordering, for exactly the tenants big enough to have the
   * problem.
   *
   * It was already true of the capped list and I did not see it until
   * paging became real.
   */
  it('★★ says "on this page" while more pages exist', async () => {
    await show([row({ id: 'lost', lastMessageAt: null })], 50, true);
    const note = screen.getByTestId('queue-undated');
    expect(note).toHaveTextContent(/on this page/i);
    expect(note).toHaveTextContent(/very end of the queue/i);
  });

  it('★★ claims the whole queue only on the last page', async () => {
    await show([row({ id: 'lost', lastMessageAt: null })], 50, false);
    const note = screen.getByTestId('queue-undated');
    expect(note).not.toHaveTextContent(/on this page/i);
    expect(note).toHaveTextContent(/can't place it in the order above/i);
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

describe('★★ the view-wide undated count, and its three states', () => {
  /*
   * ════════════════════════════════════════════════════════════════════════
   * ABSENT IS NOT ZERO, AND THIS IS THE INSTRUMENT'S OWN BLIND SPOT.
   * ════════════════════════════════════════════════════════════════════════
   * `undatedCount` is scoped to the view's filters and is cursor-blind, so
   * it answers what the per-page group could only gesture at. But it is
   * additive and absent on a service that predates it.
   *
   * Defaulting it to 0 would have the screen assert "no undated
   * conversations" on a service that cannot answer — **the instrument
   * reporting all-clear because it is not there.** That is the second time
   * today this same group would have hidden the thing it exists to show.
   */
  it('★★ a non-zero count shows even when this page holds none of them', async () => {
    /*
     * Undated rows sort LAST, so on any page but the final one the count can
     * be non-zero while the page is clean. Hiding the group because the page
     * looks fine would reinstate the defect the count fixes.
     */
    await show([row()], 50, true, 3);
    const note = screen.getByTestId('queue-undated');
    expect(note).toHaveTextContent(/3 conversations in this view/i);
    expect(note).not.toHaveTextContent(/on this page/i);
  });

  it('★★ an ABSENT count falls back to the page and says so', async () => {
    // Not zero. The service cannot answer, so the caption claims only what
    // this page can see.
    await show([row({ id: 'lost', lastMessageAt: null })], 50, true, undefined);
    const note = screen.getByTestId('queue-undated');
    expect(note).toHaveTextContent(/on this page/i);
    expect(note).not.toHaveTextContent(/in this view/i);
  });

  it('★★ never renders an absent count as zero', async () => {
    // The whole point: no "0" claim anywhere when nobody looked.
    const { container } = await show([row()], 50, true, undefined);
    expect(screen.queryByTestId('queue-undated')).toBeNull();
    expect(container.textContent ?? '').not.toMatch(/no conversation here is missing/i);
  });

  it('★ a real zero IS reported, because somebody looked and found none', async () => {
    await show([row()], 50, false, 0);
    expect(screen.queryByTestId('queue-undated')).toBeNull();
  });
});
