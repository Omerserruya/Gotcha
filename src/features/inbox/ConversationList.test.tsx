import type { ReactNode } from 'react';

import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { conversationRowSchema, queueOrder, type ConversationRow } from '@/api/contracts/inbox';
import channels from '@/i18n/messages/en/channels.json';
import messages from '@/i18n/messages/en/inbox.json';

import { ConversationList } from './ConversationList';

/*
 * ★ The established mock for this app's locale-aware `Link` — see
 *   `TeamPanel.test.tsx`. It renders a real anchor so `href` and the
 *   element TYPE can both be asserted, which is the point here: the rows
 *   were `div`s and the defect was that they were not links at all.
 *
 * ⚠ `href` is an object for a query-carrying route, so it is serialised the
 *   way `next/link` would rather than dropped — a mock that stringified it
 *   as "[object Object]" would pass a test for "has an href".
 */
vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: string | { pathname: string; query?: Record<string, string> };
    children: ReactNode;
  }) => {
    const to =
      typeof href === 'string'
        ? href
        : `${href.pathname}?${new URLSearchParams(href.query ?? {}).toString()}`;
    return (
      <a href={to} {...rest}>
        {children}
      </a>
    );
  },
}));

/*
 * ★ BOTH NAMESPACES, BECAUSE THE ROW READS BOTH.
 * The channel's display name lives in `channels`, where screen 13 already
 * maintains it in two languages — copying ten names into `inbox` would be a
 * second set of words for one set of things.
 */
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'inbox' | 'channels') =>
    createTranslator({ locale: 'en', messages: { inbox: messages, channels }, namespace }),
  /*
   * ⚠ THE ZONE IS PINNED, AND THAT IS THE POINT OF MOCKING IT AT ALL.
   *   `next-intl` is configured with `Asia/Jerusalem`; a formatter that used
   *   the runner's zone would make the asserted times depend on where the
   *   tests happen to run, and pass on a laptop while failing in CI.
   */
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Jerusalem' }),
}));

const NOW = new Date('2026-09-25T12:00:00.000Z');

const row = (over: Record<string, unknown> = {}): ConversationRow =>
  conversationRowSchema.parse({
    id: 'c1',
    status: 'OPEN',
    /*
     * ★★ `customerName`, AND THE OLD FIXTURE SAID `contactName`.
     *
     * A fixture is a claim that the platform can produce this object. This one
     * claimed a field the platform has never sent — the same invention the
     * contract carried — and **no assertion looked at the rendered name**, so
     * the row printed "Someone" and every test passed. Ten of ten rows in the
     * capture, read as redaction by the security fixtures.
     */
    customerName: 'Dana',
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

describe('★★ what the row actually says about the customer', () => {
  it('★★ shows the name, and does not fall back to "Someone" when there is one', async () => {
    /*
     * THE ASSERTION THAT WAS MISSING. The fallback is correct where there is
     * genuinely no name; it was rendering on every row because the contract
     * named a field that does not exist, and nothing checked the output.
     */
    await show([row({ customerName: 'Dana' })]);
    expect(screen.getByText('Dana')).toBeInTheDocument();
    expect(screen.queryByText(/someone/i)).toBeNull();
  });

  it('★ still says "Someone" when the platform really sends no name', async () => {
    // `customerName` is nullable on the model. An unnamed customer is a real
    // state and the fallback is for that, not for a contract mistake.
    await show([row({ customerName: null })]);
    expect(screen.getByText(/someone/i)).toBeInTheDocument();
  });

  it('★★ names the channel instead of printing its enum', async () => {
    /*
     * `SHOPIFY_LIVE_CHAT` was on screen in the capture. The label has existed
     * in `channels.name.*` in both languages the whole time.
     */
    await show([row({ channel: 'SHOPIFY_LIVE_CHAT' })]);
    expect(screen.getByText(/shopify live chat/i)).toBeInTheDocument();
    expect(screen.queryByText(/SHOPIFY_LIVE_CHAT/)).toBeNull();
  });

  it('★★ no screaming-snake value reaches the screen, whatever the channel is', async () => {
    /*
     * The durable form of the rule: an unconstrained column can hold a value
     * this build has never seen, and the answer is "another channel" — not the
     * raw string, which every other screen here strips.
     */
    await show([row({ channel: 'SOME_NEW_CHANNEL' })]);
    expect(screen.getByText(/another channel/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/[A-Z]{2,}_[A-Z]{2,}/);
  });
});

describe('★★ a wait at a scale somebody can read', () => {
  it('★★ hours, not 47061m', async () => {
    /*
     * THE DEFECT THE CAPTURE FOUND. The row printed raw minutes, so a
     * thirty-two-day wait rendered as `47061m` on the column an agent triages
     * on — and it was illegible enough to be reported as a possible
     * identifier rather than a duration.
     */
    await show([row({ lastMessageAt: '2026-09-25T09:00:00.000Z' })]);
    const waiting = screen.getByTestId('waiting-c1');
    expect(waiting).toHaveTextContent(/3 hours waiting/i);
    expect(waiting).not.toHaveTextContent(/180m/);
  });

  it('★★ days for the ones that have been there a month', async () => {
    await show([row({ lastMessageAt: '2026-08-24T12:00:00.000Z' })]);
    const waiting = screen.getByTestId('waiting-c1');
    expect(waiting).toHaveTextContent(/32 days waiting/i);
    expect(waiting).not.toHaveTextContent(/\d{4,}/);
  });

  it('★ minutes below the hour, which is the case that was always right', async () => {
    await show([row({ lastMessageAt: '2026-09-25T11:46:00.000Z' })]);
    expect(screen.getByTestId('waiting-c1')).toHaveTextContent('14m');
  });

  it('★★ nothing in the queue is ever a bare four-digit number', async () => {
    // The shape of the defect rather than one instance of it: any wait long
    // enough to need another unit must have been given one.
    await show([
      row({ id: 'a', lastMessageAt: '2026-09-25T11:00:00.000Z' }),
      row({ id: 'b', lastMessageAt: '2026-09-20T12:00:00.000Z' }),
      row({ id: 'c', lastMessageAt: '2026-06-01T12:00:00.000Z' }),
    ]);
    expect(document.body.textContent).not.toMatch(/\b\d{4,}m\b/);
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

describe('⚠⚠ the rows were not clickable, on the screen whose job is clicking them', () => {
  /* Two rows with known ids, so an `href` can be asserted against one. */
  const queue = () => [row({ id: 'c1' }), row({ id: 'c2' })];

  /*
   * ════════════════════════════════════════════════════════════════════════
   * MEASURED ON THE DEPLOYED BUILD
   * ════════════════════════════════════════════════════════════════════════
   *     element        DIV
   *     role/tabindex  none / none
   *     links/buttons  0
   *     cursor         auto
   *     right-click    0 menu elements
   *
   * ★ The only way into a conversation was typing `?c=<id>` in the address
   *   bar. That is not a styling gap — it is the screen's primary function
   *   missing, and it explains "light years from the target" better than any
   *   spacing value.
   */
  it('★★ every row is a link to that conversation', async () => {
    render(await ConversationList({ rows: queue(), cap: 10, now: NOW, hasMore: false }));

    const rows = screen.getAllByRole('link');
    expect(rows.length).toBe(queue().length);
    expect(rows[0]).toHaveAttribute('href', expect.stringContaining('c=c1'));
  });

  it('⚠⚠ a LINK, not a button, because a conversation has a URL', async () => {
    /*
     * ★ The prototype draws `<button onClick>` because a static mock has no
     *   routing. An anchor gives middle-click, open-in-new-tab, the browser's
     *   own context menu — which the reviewer asked about by name — keyboard
     *   focus and a status-bar preview. A button reimplements those badly or
     *   not at all.
     *
     * ★ Same reading as the code field's caret: when the mock draws something
     *   the platform provides, it is describing an outcome, not an
     *   implementation.
     */
    render(await ConversationList({ rows: queue(), cap: 10, now: NOW, hasMore: false }));

    expect(screen.queryAllByRole('button')).toHaveLength(0);
    for (const row of screen.getAllByRole('link')) {
      expect(row.tagName).toBe('A');
    }
  });

  it('⚠⚠ uses `c`, the parameter this app actually reads', async () => {
    /*
     * ★ `inbox/page.tsx` destructures `c`, and it is the only reader. A walk
     *   quoted `?conversation=` — that was the harness's URL, not ours, and
     *   building the link on it would have produced rows that navigate to a
     *   page which opens nothing.
     */
    render(await ConversationList({ rows: queue(), cap: 10, now: NOW, hasMore: false }));

    const href = screen.getAllByRole('link')[0]!.getAttribute('href') ?? '';
    expect(new URL(href, 'https://x.test').searchParams.get('c')).toBe('c1');
    expect(href).not.toContain('conversation=');
  });

  it('★★ the open conversation says so, and the others do not', async () => {
    /*
     * ⚠ In the capture the open conversation's row was visually identical to
     *   the other nine. A queue that cannot show you where you are is a list
     *   you re-read after every reply.
     */
    render(
      await ConversationList({ rows: queue(), cap: 10, now: NOW, hasMore: false, openId: 'c2' }),
    );

    const rows = screen.getAllByRole('link');
    const current = rows.filter((row) => row.getAttribute('aria-current') === 'true');

    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAttribute('href', expect.stringContaining('c=c2'));
  });

  it('⚠ and with nothing open, no row claims to be current', async () => {
    // Both directions. A row that is always current is the same defect
    // wearing the opposite sign.
    render(await ConversationList({ rows: queue(), cap: 10, now: NOW, hasMore: false }));
    for (const row of screen.getAllByRole('link')) {
      expect(row).not.toHaveAttribute('aria-current');
    }
  });
});

describe('⚠⚠ the row the design draws, and the line it exists for', () => {
  /*
   * ════════════════════════════════════════════════════════════════════════
   * `lastMessageBody` WAS IN THE CONTRACT AND RENDERED NOWHERE
   * ════════════════════════════════════════════════════════════════════════
   * Parsed by `conversationRowSchema` on every page load and discarded. The
   * row's whole purpose — what the person actually said — was being fetched
   * and thrown away, which is the fourth value today that existed and had no
   * reader.
   */
  it('★★ shows the message preview', async () => {
    render(
      await ConversationList({
        rows: [row({ lastMessageBody: "My package still hasn't arrived" })],
        cap: 10,
        now: NOW,
        hasMore: false,
      }),
    );
    expect(screen.getByTestId('preview-c1')).toHaveTextContent("My package still hasn't arrived");
  });

  it('⚠ and says nothing rather than an empty line when there is no message', async () => {
    // A row with no last message is a real state — a conversation opened and
    // never spoken in. An empty preview slot would reserve space for nothing.
    render(
      await ConversationList({
        rows: [row({ lastMessageBody: null })],
        cap: 10,
        now: NOW,
        hasMore: false,
      }),
    );
    expect(screen.queryByTestId('preview-c1')).toBeNull();
  });

  it('★★ shows the last-message TIME, in the configured zone', async () => {
    /*
     * ★ The design puts last-message time here and waiting-age in the tag
     *   row. Both facts kept, each in its own slot, rather than one standing
     *   in for the other — which is what we were doing.
     *
     * ⚠ 06:29 UTC is 09:29 in Asia/Jerusalem, which is the configured zone
     *   and the time the design's own screenshot shows. A formatter using the
     *   server's zone would render 06:29 and look right to whoever deployed
     *   it.
     */
    render(
      await ConversationList({
        rows: [row({ lastMessageAt: '2026-09-25T06:29:00.000Z' })],
        cap: 10,
        now: NOW,
        hasMore: false,
      }),
    );
    expect(screen.getByTestId('time-c1')).toHaveTextContent('09:29');
  });

  it('★ and waiting-age is still there, moved to the tag row', async () => {
    // It is what the queue is sorted by. The design keeps it — as a tag.
    render(
      await ConversationList({
        rows: [row({ lastMessageAt: '2026-09-25T06:29:00.000Z' })],
        cap: 10,
        now: NOW,
        hasMore: false,
      }),
    );
    expect(screen.getByTestId('waiting-c1')).toBeInTheDocument();
  });

  it('⚠⚠ initials come from WORDS, never a slice of the raw name', async () => {
    /*
     * ★ `customerName` is not always a person. A Shopify live-chat row reads
     *   "Shopper on urban-supply-gotcha-demo.myshopify.com" — slicing that
     *   would put a fragment of a shop domain in the avatar circle.
     */
    render(
      await ConversationList({
        rows: [
          row({ id: 'c1', customerName: 'Dana Cohen' }),
          row({ id: 'c2', customerName: 'Shopper on urban-supply-gotcha-demo.myshopify.com' }),
        ],
        cap: 10,
        now: NOW,
        hasMore: false,
      }),
    );
    const circles = screen.getAllByRole('link').map((r) => r.firstElementChild?.textContent);
    expect(circles[0]).toBe('DC');
    expect(circles[1]).toBe('SO');
    expect(circles[1]).not.toContain('myshopify');
  });

  it('⚠ an unnamed row gets an empty circle, not a placeholder glyph', async () => {
    render(
      await ConversationList({
        rows: [row({ customerName: null })],
        cap: 10,
        now: NOW,
        hasMore: false,
      }),
    );
    // The name beside it already says "Someone"; the circle is decorative.
    expect(screen.getAllByRole('link')[0]!.firstElementChild?.textContent).toBe('');
  });
});
