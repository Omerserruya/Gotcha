import { readFileSync } from 'node:fs';

import type { ReactNode } from 'react';

import { render as rtlRender, screen, within } from '@testing-library/react';
import { createFormatter, createTranslator, NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { conversationRowSchema, queueOrder, type ConversationRow } from '@/api/contracts/inbox';
import channels from '@/i18n/messages/en/channels.json';
import navigation from '@/i18n/messages/en/navigation.json';
import messages from '@/i18n/messages/en/inbox.json';

import { ConversationList } from './ConversationList';
import { QUEUE_CHANNEL_FILTERS } from './inbox-views';

/*
 * ★ The established mock for this app's locale-aware `Link` - see
 *   `TeamPanel.test.tsx`. It renders a real anchor so `href` and the
 *   element TYPE can both be asserted, which is the point here: the rows
 *   were `div`s and the defect was that they were not links at all.
 *
 * ⚠ `href` is an object for a query-carrying route, so it is serialised the
 *   way `next/link` would rather than dropped - a mock that stringified it
 *   as "[object Object]" would pass a test for "has an href".
 */
/*
 * ★ The rows sit inside `QueueMenu`, a client component with its own
 *   translations - so every render here is inside the provider the app has.
 */
const render = (ui: ReactNode) =>
  rtlRender(ui, {
    wrapper: ({ children }) => (
      <NextIntlClientProvider locale="en" messages={{ inbox: messages }}>
        {children}
      </NextIntlClientProvider>
    ),
  });

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
 * maintains it in two languages - copying ten names into `inbox` would be a
 * second set of words for one set of things.
 */
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'inbox' | 'channels' | 'navigation') =>
    createTranslator({
      locale: 'en',
      messages: { inbox: messages, channels, navigation },
      namespace,
    }),
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
     * claimed a field the platform has never sent - the same invention the
     * contract carried - and **no assertion looked at the rendered name**, so
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

/*
 * The ROW links. The header's filter chips are links too, so "every link"
 * stopped meaning "every row" when the filter row arrived.
 */
const rowLinks = () => screen.getAllByRole('link').filter((link) => link.closest('ol') !== null);

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
   * hidden problem visible is itself empty on every page but the last -
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
     * ten call sites, and writers bypass it - one conversation on dev is
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
    // the array in whatever order it arrived - an ordering nobody chose,
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

    /*
     * ⚠ THE NAME MOVED, THE RULE DID NOT. It used to print in the tag row;
     *   the avatar now carries a tinted channel badge, so the word would be a
     *   duplicate spending the row's one coloured slot. It is the badge's
     *   accessible name instead - because a tint and a glyph say nothing to
     *   somebody who cannot see them.
     */
    expect(screen.getByTitle(/shopify live chat/i)).toBeInTheDocument();
    expect(screen.queryByText(/SHOPIFY_LIVE_CHAT/)).toBeNull();
  });

  it('★★ no screaming-snake value reaches the screen, whatever the channel is', async () => {
    /*
     * The durable form of the rule: an unconstrained column can hold a value
     * this build has never seen, and the answer is "another channel" - not the
     * raw string, which every other screen here strips.
     */
    await show([row({ channel: 'SOME_NEW_CHANNEL' })]);
    expect(screen.getByTitle(/another channel/i)).toBeInTheDocument();

    /*
     * ⚠ THE SWEEP NOW READS ATTRIBUTES TOO, AND THAT IS THE POINT. The rule
     *   is that a raw enum never reaches a person - moving the name into a
     *   `title` would have slipped past a check that only read text, and the
     *   guard would have stayed green while the thing it guards moved out of
     *   its view.
     */
    expect(document.body.innerHTML).not.toMatch(/[A-Z]{2,}_[A-Z]{2,}/);
  });
});

describe('★★ a wait at a scale somebody can read', () => {
  it('★★ hours, not 47061m', async () => {
    /*
     * THE DEFECT THE CAPTURE FOUND. The row printed raw minutes, so a
     * thirty-two-day wait rendered as `47061m` on the column an agent triages
     * on - and it was illegible enough to be reported as a possible
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
     * thing in the queue - a fabricated recency, the same shape as the 0s
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
   * conversations" on a service that cannot answer - **the instrument
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
   *   bar. That is not a styling gap - it is the screen's primary function
   *   missing, and it explains "light years from the target" better than any
   *   spacing value.
   */
  it('★★ every row is a link to that conversation', async () => {
    render(await ConversationList({ rows: queue(), cap: 10, now: NOW, hasMore: false }));

    const rows = rowLinks();
    expect(rows.length).toBe(queue().length);
    expect(rows[0]).toHaveAttribute('href', expect.stringContaining('c=c1'));
  });

  it('⚠⚠ a LINK, not a button, because a conversation has a URL', async () => {
    /*
     * ★ The prototype draws `<button onClick>` because a static mock has no
     *   routing. An anchor gives middle-click, open-in-new-tab, the browser's
     *   own context menu - which the reviewer asked about by name - keyboard
     *   focus and a status-bar preview. A button reimplements those badly or
     *   not at all.
     *
     * ★ Same reading as the code field's caret: when the mock draws something
     *   the platform provides, it is describing an outcome, not an
     *   implementation.
     */
    render(await ConversationList({ rows: queue(), cap: 10, now: NOW, hasMore: false }));

    expect(screen.queryAllByRole('button')).toHaveLength(0);
    for (const row of rowLinks()) {
      expect(row.tagName).toBe('A');
    }
  });

  it('⚠⚠ uses `c`, the parameter this app actually reads', async () => {
    /*
     * ★ `inbox/page.tsx` destructures `c`, and it is the only reader. A walk
     *   quoted `?conversation=` - that was the harness's URL, not ours, and
     *   building the link on it would have produced rows that navigate to a
     *   page which opens nothing.
     */
    render(await ConversationList({ rows: queue(), cap: 10, now: NOW, hasMore: false }));

    const href = rowLinks()[0]!.getAttribute('href') ?? '';
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

    const rows = rowLinks();
    const current = rows.filter((row) => row.getAttribute('aria-current') === 'true');

    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAttribute('href', expect.stringContaining('c=c2'));
  });

  it('⚠ and with nothing open, no row claims to be current', async () => {
    // Both directions. A row that is always current is the same defect
    // wearing the opposite sign.
    render(await ConversationList({ rows: queue(), cap: 10, now: NOW, hasMore: false }));
    for (const row of rowLinks()) {
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
   * row's whole purpose - what the person actually said - was being fetched
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

  it('⚠ keeps an EMPTY line when there is no body - no text invented', async () => {
    // A media message has no body and the list sends no type. Dropping the
    // line made those rows 69 tall among 82s; 02 has three lines on every row.
    render(
      await ConversationList({
        rows: [row({ lastMessageBody: null })],
        cap: 10,
        now: NOW,
        hasMore: false,
      }),
    );
    const preview = screen.getByTestId('preview-c1');
    expect(preview.textContent).toBe('');
    expect(preview).toHaveAttribute('data-empty');
  });

  it('★★ shows the last-message TIME, in the configured zone', async () => {
    /*
     * ★ The design puts last-message time here and waiting-age in the tag
     *   row. Both facts kept, each in its own slot, rather than one standing
     *   in for the other - which is what we were doing.
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
    // It is what the queue is sorted by. The design keeps it - as a tag.
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
     *   "Shopper on urban-supply-gotcha-demo.myshopify.com" - slicing that
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
    const circles = rowLinks().map((r) => r.firstElementChild?.textContent);
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
    expect(rowLinks()[0]!.firstElementChild?.textContent).toBe('');
  });
});

describe('⚠⚠ the channel badge I said could not be built', () => {
  /*
   * ════════════════════════════════════════════════════════════════════════
   * I GREPPED THE PROTOTYPE AND CONCLUDED ABOUT THE DIRECTIONS
   * ════════════════════════════════════════════════════════════════════════
   * `GOTCHA Prototype.dc.html` is a TEMPLATE: it draws the badge as
   * `background: url({{ c.chIcon }})`, so I reported that the design wanted
   * brand images we do not have. `GOTCHA Directions.dc.html` renders the same
   * badge as `<i data-lucide="message-circle">`.
   *
   * ★ Two files, two representations of one design - and I read the one whose
   *   templating happened to express the icon as a URL variable. The fourth
   *   wrong negative today, and the one that cost the most visible element in
   *   the row.
   */
  const toneOf = (testid: string) =>
    screen.getByTestId(testid).querySelector('[data-tone]')?.getAttribute('data-tone');

  it('★★ tints each channel the design’s way', async () => {
    render(
      await ConversationList({
        rows: [
          row({ id: 'c1', channel: 'WHATSAPP' }),
          row({ id: 'c2', channel: 'EMAIL' }),
          row({ id: 'c3', channel: 'INSTAGRAM' }),
        ],
        cap: 10,
        now: NOW,
        hasMore: false,
      }),
    );
    expect(toneOf('conversation-c1')).toBe('whatsapp');
    expect(toneOf('conversation-c2')).toBe('email');
    expect(toneOf('conversation-c3')).toBe('instagram');
  });

  it('⚠⚠ an unrecognised channel gets the globe, never nothing', async () => {
    /*
     * `channel` is an unconstrained column - the same reason `channelName`
     * answers "another channel" rather than echoing a raw enum. A row with no
     * mark would read as a different KIND of row rather than an unknown one.
     */
    render(
      await ConversationList({
        rows: [row({ id: 'c1', channel: 'SOMETHING_NEW' }), row({ id: 'c2', channel: null })],
        cap: 10,
        now: NOW,
        hasMore: false,
      }),
    );
    expect(toneOf('conversation-c1')).toBe('web');
    expect(toneOf('conversation-c2')).toBe('web');
  });
});

describe('⚠⚠ a settled row is drawn quieter, and every row looked the same', () => {
  /*
   * 02 draws a resolved conversation softer in five separate ways: name
   * weight, name colour, preview colour, time colour, avatar tint. We drew
   * every row identically - which is why the column read flat, and it is not
   * a spacing problem.
   */
  it('★★ marks CLOSED rows, and leaves live ones alone', async () => {
    render(
      await ConversationList({
        rows: [
          row({ id: 'c1', status: 'CLOSED' }),
          row({ id: 'c2', status: 'OPEN' }),
          row({ id: 'c3', status: 'WAITING' }),
        ],
        cap: 10,
        now: NOW,
        hasMore: false,
      }),
    );
    expect(screen.getByTestId('conversation-c1')).toHaveAttribute('data-settled');
    expect(screen.getByTestId('conversation-c2')).not.toHaveAttribute('data-settled');
    /*
     * ⚠ WAITING IS NOT SETTLED. It is the most live state in the queue -
     *   somebody is waiting for a reply - and reading it as "done" would
     *   quiet exactly the rows that need attention most.
     */
    expect(screen.getByTestId('conversation-c3')).not.toHaveAttribute('data-settled');
  });
});

describe('⚠⚠ two tags on real data, not six where four are fiction', () => {
  /*
   * ════════════════════════════════════════════════════════════════════════
   * THE DESIGN RENDERS NINE TAG TEXTS. THEY SPLIT THREE WAYS.
   * ════════════════════════════════════════════════════════════════════════
   *   buildable   "You" (assignedAgentId === me) · "Flow" (handledBy)
   *   needs a     "Support AI" / "Sales AI" - the row carries
   *   name          `assignedAiAgentId`, an id with no name
   *   no field    "Shipping issue" · "High intent" · "Waiting on returns" ·
   *               "Approval needed" - a classification nobody stores
   *
   * ⚠ The last four are NOT approximations of `status`. "Waiting on returns"
   *   is not `WAITING`, and a mapping that looks right on three rows is the
   *   kind of invention that reads as working.
   */
  it('★★ says "You" only on rows assigned to the viewer', async () => {
    render(
      await ConversationList({
        rows: [row({ id: 'c1', assignedAgentId: 'u1' }), row({ id: 'c2', assignedAgentId: 'u2' })],
        cap: 10,
        now: NOW,
        hasMore: false,
        meId: 'u1',
      }),
    );
    expect(screen.getByTestId('tag-you-c1')).toBeInTheDocument();
    expect(screen.queryByTestId('tag-you-c2')).toBeNull();
  });

  it('⚠⚠ and never when the viewer is unknown', async () => {
    /*
     * ★ `meId` is null when `/auth/me` failed - a real state, handled
     *   elsewhere in this feature by withholding controls. A row claiming to
     *   be "yours" when we do not know who you are is worse than no tag:
     *   every row would claim it.
     */
    render(
      await ConversationList({
        rows: [
          row({ id: 'c1', assignedAgentId: 'u1' }),
          /*
           * ⚠⚠ THE CASE A SURVIVING MUTATION FOUND, AND IT IS THE COMMON ONE.
           *   An UNASSIGNED row has `assignedAgentId: null`. With `meId` also
           *   null, `null === null` is true - so without the explicit guard
           *   **every unassigned row in the queue would claim to be yours**,
           *   which on a triage column is the worst possible lie.
           *
           * ★ My first version only used an assigned row, where the
           *   comparison is false anyway and the guard looks redundant.
           */
          row({ id: 'c2', assignedAgentId: null }),
        ],
        cap: 10,
        now: NOW,
        hasMore: false,
        meId: null,
      }),
    );
    expect(screen.queryByTestId('tag-you-c1')).toBeNull();
    expect(screen.queryByTestId('tag-you-c2')).toBeNull();
  });

  it('★★ says "Flow" on flow-handled rows, and not on the other two', async () => {
    // `HANDLED_BY` is ['ai_agent','flow','human'] and the design's tag is the
    // literal word "Flow" - an exact match, which is why it is buildable and
    // "Support AI" is not.
    render(
      await ConversationList({
        rows: [
          row({ id: 'c1', handledBy: 'flow' }),
          row({ id: 'c2', handledBy: 'ai_agent' }),
          row({ id: 'c3', handledBy: 'human' }),
        ],
        cap: 10,
        now: NOW,
        hasMore: false,
      }),
    );
    expect(screen.getByTestId('tag-flow-c1')).toBeInTheDocument();
    expect(screen.queryByTestId('tag-flow-c2')).toBeNull();
    expect(screen.queryByTestId('tag-flow-c3')).toBeNull();
  });
});

describe('★★ the cap caption found the home the design gave it', () => {
  it('⚠⚠ is the card’s footer bar, and says nothing about a menu', async () => {
    /*
     * 02 closes the queue card with a bar reading "Shift-click to pick
     * several · right-click for actions".
     *
     * ⚠ WE DO NOT SHIP THAT SENTENCE. It is the only thing telling anyone the
     *   context menu exists, and it promises multi-select the menu acts on.
     *   Neither is built, so printing it would be the screen describing a
     *   feature it does not have.
     *
     * ★ But the BAR is the home the cap caption never had - it used to sit
     *   where the design puts the column header.
     */
    render(await ConversationList({ rows: [row()], cap: 10, now: NOW, hasMore: false }));

    const footer = screen.getByTestId('queue-cap');
    expect(footer.textContent).not.toMatch(/right-click|shift-click/i);
    /*
     * ⚠ ASSERTED AS THE SENTENCE, NOT AS "CONTAINS A DIGIT". My first version
     *   wanted `/\d/` - and the catalogue spells "One conversation" for a
     *   count of one, so the proxy failed on correct copy. Fourth time today.
     */
    expect(footer.textContent).toMatch(/conversation/i);
  });
});

describe('⚠⚠ 24-hour time, because the zone and the format are two defaults', () => {
  it('★★ renders 09:29, not 07:48 PM', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * PINNING THE ZONE WAS RIGHT AND WAS NOT ENOUGH
     * ════════════════════════════════════════════════════════════════════════
     * `hour12` follows the LOCALE by default. The deployed build rendered
     * "07:48 PM" in `en` while `he` would render "19:48" - the two locales
     * disagreeing about a thing 02 states once, on every row, as `09:29`.
     *
     * ★ Two separate defaults, and only one of them was wrong at a time.
     */
    render(
      await ConversationList({
        rows: [row({ lastMessageAt: '2026-09-25T16:48:00.000Z' })],
        cap: 10,
        now: NOW,
        hasMore: false,
      }),
    );
    const time = screen.getByTestId('time-c1').textContent ?? '';

    expect(time).toMatch(/^\d{2}:\d{2}$/);
    expect(time).not.toMatch(/AM|PM/i);
    // 16:48 UTC is 19:48 in Asia/Jerusalem - zone AND format together.
    expect(time).toBe('19:48');
  });
});

describe('⚠⚠ "every thing in its own container" - the panel, and how a row is marked', () => {
  it('★★ the open row is marked, and the mark is on the ROW not the list', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * 02: WHITE ROW, BLACK LEFT EDGE, NO TOP HAIRLINE
     * ════════════════════════════════════════════════════════════════════════
     * Two signals, not one - and the 3px slot is on EVERY row at transparent,
     * so nothing shifts by three pixels when selection moves. That is the
     * reasoning I wrote by hand for `aria-current`; the design had it as
     * geometry.
     */
    render(
      await ConversationList({
        rows: [row({ id: 'c1' }), row({ id: 'c2' })],
        cap: 10,
        now: NOW,
        hasMore: false,
        openId: 'c2',
      }),
    );
    expect(screen.getByTestId('conversation-c2')).toHaveAttribute('data-open');
    expect(screen.getByTestId('conversation-c1')).not.toHaveAttribute('data-open');
  });

  it('★★ the panel has a header, counting what this page holds', async () => {
    /*
     * ⚠ THE COUNT IS THIS PAGE, NOT THE QUEUE. The design shows 14 beside the
     *   heading; we do not know the total when `hasMore` is true - the route
     *   pages by keyset and reports no grand count. Printing a page size as a
     *   queue size would be the cap defect the footer sentence exists to
     *   prevent, moved into a number.
     */
    render(
      await ConversationList({
        rows: [row({ id: 'c1' }), row({ id: 'c2' }), row({ id: 'c3' })],
        cap: 10,
        now: NOW,
        hasMore: true,
      }),
    );
    expect(screen.getByTestId('queue-count')).toHaveTextContent('3');
    expect(screen.getByText(/waiting in queue/i)).toBeInTheDocument();
  });

  it('★★ the route’s `viewTotal` is the count when it sends one - the whole view, not the page', async () => {
    render(
      await ConversationList({
        rows: [row({ id: 'c1' }), row({ id: 'c2' }), row({ id: 'c3' })],
        cap: 10,
        now: NOW,
        hasMore: true,
        viewTotal: 14,
      }),
    );
    expect(screen.getByTestId('queue-count')).toHaveTextContent(/^14$/);
  });

  it('⚠ and says zero rather than nothing when the page is empty', async () => {
    /*
     * ⚠ A MUTATION SURVIVED HERE AND THE REASON IS WORTH RECORDING RATHER
     *   THAN PAPERING OVER: replacing `rows?.length ?? 0` with `rows?.length`
     *   breaks nothing, because `[].length` is 0 and the only other case -
     *   `rows === null` - RETURNS EARLY with the unavailable panel.
     *
     * ★ So the `?? 0` is reachable only through the type, not through the
     *   program. It stays because `rows` is nullable in the signature, and
     *   this test covers the empty page, which is a real state. Adding an
     *   assertion that only satisfies the mutant would be inventing coverage.
     */
    render(await ConversationList({ rows: [], cap: 10, now: NOW, hasMore: false }));
    expect(screen.getByTestId('queue-count')).toHaveTextContent('0');
  });
});

describe('⚠⚠ "a WINDOW YOU SCROLL INSIDE, not outside"', () => {
  /*
   * ════════════════════════════════════════════════════════════════════════
   * THE PANELS RAN OFF THE BOTTOM AND THE PAGE SCROLLED INSTEAD
   * ════════════════════════════════════════════════════════════════════════
   * Measured on the rendered 02: the frame is a fixed 900px with
   * `overflow:hidden`, and each panel is exactly 876px - 900 less its 12px
   * padding - also hidden, also a flex column. A fixed-height flex column
   * that hides overflow is a window whose INNER region scrolls.
   *
   * ★ And the footer bar is the proof the structure is right: 02 welds it to
   *   the panel's bottom with `border-radius: 0 0 18px 18px`. **A footer at
   *   the bottom of a panel only works if the panel HAS a bottom.**
   */
  const css = readFileSync('src/features/inbox/Inbox.module.css', 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  // The selector's OWN rule: first on its line, not a descendant in another
  // rule (`.queueRow[data-settled] .who`) and not a list's second entry.
  const rule = (selector: string) =>
    new RegExp(`(?:^|\\n)\\s*(?<!,\\s*)\\.${selector}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';

  it('★★ the list sits in a scroll region, and the header and footer do not', async () => {
    render(await ConversationList({ rows: [row()], cap: 10, now: NOW, hasMore: false }));

    const scroll = screen.getByTestId('conversation-list').querySelector('div');
    expect(scroll).not.toBeNull();
    expect(rule('queueScroll')).toMatch(/overflow-y:\s*auto/);
    expect(rule('queueHeader')).toMatch(/flex:\s*none/);
    expect(rule('queueFooter')).toMatch(/flex:\s*none/);
  });

  it('⚠⚠ and the scroll region can SHRINK, which is the whole thing', async () => {
    /*
     * ★★ `min-block-size: 0` is the declaration it all turns on. Without it a
     *   flex child refuses to go below its content: the list pushes the panel
     *   taller, the panel overflows the frame, and you get a box with no
     *   bottom rather than a window that scrolls.
     *
     * ⚠ It is one line, it looks like boilerplate, and it is the difference
     *   between the complaint and the design.
     */
    expect(rule('queueScroll')).toMatch(/min-block-size:\s*0/);
  });

  it('★ the panel itself clips, so rows cannot escape its rounded corners', async () => {
    const columns = /\.queueColumn,[\s\S]*?\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(columns).toMatch(/overflow:\s*hidden/);
    expect(columns).toMatch(/min-block-size:\s*0/);
  });

  it('⚠⚠ the queue lines are `normal`, not the body’s 1.6', () => {
    /*
     * 02 sets no line-height in the queue. Inheriting 1.6 made every line
     * taller with every other value right: rows 94h against 86h, header 97h
     * against 87h. Measured on the deployed build, one cause for all of it.
     */
    expect(rule('queueColumn')).toMatch(/line-height:\s*normal/);
  });

  it('⚠⚠ a name is 500, not 600 - 600 is 02’s UNREAD, and we cannot say that', () => {
    expect(rule('who')).toMatch(/font-weight:\s*var\(--font-weight-medium\)/);
  });

  it('★ the open row drops its top line - width 0, not a transparent 1px', () => {
    const open = /\.queueRow\[data-open\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(open).toMatch(/border-block-start-width:\s*0/);
  });

  it('★ waiting-age is a pill in 02’s neutral, so the third line is 17h', () => {
    // As running text it was 11h, and that was the whole of 76 against 82.
    expect(rule('waiting')).toMatch(/padding:\s*3px var\(--space-8\)/);
    expect(rule('waiting')).toMatch(/background-color:\s*var\(--panel-well\)/);
  });

  it('★ the footer bar is 02’s: `padding:11px 18px` on #F5F2EC', () => {
    expect(rule('queueFooter')).toMatch(/padding:\s*11px 18px/);
    expect(rule('queueFooter')).toMatch(/background-color:\s*var\(--panel-footer\)/);
    expect(readFileSync('src/design-system/tokens/tokens.css', 'utf8')).toMatch(
      /--panel-footer:\s*#f5f2ec/i,
    );
  });
});

describe('★★ the Copilot wall is dark, and inherits only the panel’s bottom corner', () => {
  const css = readFileSync('src/features/inbox/Inbox.module.css', 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  const context = /\.contextColumn\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  const tokens = readFileSync('src/design-system/tokens/tokens.css', 'utf8');

  it('⚠⚠ is the computed rgb(23,23,23), not the light panel colour', () => {
    // A surviving mutation put it back on `--panel-base` with nothing going
    // red. Dark against the panel's light is half of what makes it a wall.
    expect(context).toMatch(/background-color:\s*var\(--copilot-surface\)/);
    expect(tokens).toMatch(/--copilot-surface:\s*#171717/i);
  });

  it('⚠⚠ its body scrolls and can SHRINK - the third of 02\u2019s three scrollers', () => {
    // Same three declarations as the queue list and the message stream, and
    // the same one that matters: without `min-block-size: 0` the body pushes
    // the wall taller than the panel it is part of.
    const body = /\.contextColumn\s*>\s*\.copilotBody\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(body).toMatch(/flex:\s*1/);
    expect(body).toMatch(/min-block-size:\s*0/);
    expect(body).toMatch(/overflow-y:\s*auto/);
  });

  it('★ rounds ONLY the bottom-right, because the panel rounds the rest', () => {
    expect(context).toMatch(/border-end-end-radius:\s*18px/);
    expect(context).not.toMatch(/(?:^|\s)border-radius:/);
  });
});

describe('⚠⚠ the queue is 352px at the width the design was drawn at', () => {
  it('★★ the clamp’s percentage is of the CONTENT box, not the viewport', () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * IT WAS 21%, AND IT RENDERED 260px
     * ════════════════════════════════════════════════════════════════════════
     * A percentage width resolves against its containing block - the content
     * area beside the rail, `[1218x876]` in 02's computed tree. 21% of 1218 is
     * 256, the floor caught it, and the queue came out 92px narrower than
     * drawn. Both of us had reasoned about 21% of 1440.
     */
    const tokens = readFileSync('src/design-system/tokens/tokens.css', 'utf8');
    const m = /--size-inbox-queue:\s*clamp\((\d+)px,\s*([\d.]+)%,\s*(\d+)px\)/.exec(tokens);
    expect(m).not.toBeNull();

    const [, floor, pct, ceiling] = m!.map(Number) as [number, number, number, number];
    const atDesignWidth = Math.min(Math.max((1218 * pct) / 100, floor), ceiling);

    expect(Math.round(atDesignWidth)).toBe(352);
  });
});

describe('⚠⚠ the heading names the view it is heading', () => {
  it('★★ says Resolved over the resolved list, not "Waiting in queue"', async () => {
    /*
     * ⚠ THE HEADING SAID "Waiting in queue" ON EVERY VIEW - including
     *   Resolved, whose rows are by definition not waiting. A surviving
     *   mutation found that the only test used the default view, where the
     *   right heading and the wrong one are the same words.
     */
    render(
      await ConversationList({
        rows: [row()],
        cap: 10,
        now: NOW,
        hasMore: false,
        view: 'resolved',
      }),
    );
    const heading = screen.getByTestId('conversation-list').querySelector('header');
    expect(heading?.textContent).toMatch(new RegExp(navigation.inbox.resolved, 'i'));
    expect(heading?.textContent).not.toMatch(/waiting in queue/i);
  });
});

describe("★★ Wave 2 - 02's filter row, and every chip in it filters", () => {
  const queue = () => [row({ id: 'c1' }), row({ id: 'c2' })];
  const chips = () => within(screen.getByTestId('queue-filters')).getAllByRole('link');
  const params = (el: Element) =>
    new URL(el.getAttribute('href') ?? '', 'https://x.test').searchParams;

  it('★★ "All" then the five channels, in 02\'s order, each named', async () => {
    render(await ConversationList({ rows: queue(), cap: 10, now: NOW, hasMore: false }));
    expect(chips().map((c) => c.getAttribute('aria-label') ?? c.textContent)).toEqual([
      'All',
      'WhatsApp',
      'Instagram',
      'Messenger',
      'Email',
      'Web chat',
    ]);
  });

  it('★★ each chip filters by its channel and keeps the view', async () => {
    render(
      await ConversationList({
        rows: queue(),
        cap: 10,
        now: NOW,
        hasMore: false,
        view: 'resolved',
      }),
    );
    const instagram = screen.getByTestId('filter-INSTAGRAM');
    expect(params(instagram).get('channel')).toBe('INSTAGRAM');
    expect(params(instagram).get('view')).toBe('resolved');
    // "All" clears the channel and nothing else.
    expect(params(screen.getByTestId('filter-all')).get('channel')).toBeNull();
    expect(params(screen.getByTestId('filter-all')).get('view')).toBe('resolved');
  });

  it('★ the filter in force is the one marked current - exactly one', async () => {
    render(
      await ConversationList({
        rows: queue(),
        cap: 10,
        now: NOW,
        hasMore: false,
        channel: 'EMAIL',
      }),
    );
    const current = chips().filter((c) => c.getAttribute('aria-current') === 'true');
    expect(current.map((c) => c.dataset.testid)).toEqual(['filter-EMAIL']);
  });

  it('★ and with no channel, "All" is current', async () => {
    render(await ConversationList({ rows: queue(), cap: 10, now: NOW, hasMore: false }));
    const current = chips().filter((c) => c.getAttribute('aria-current') === 'true');
    expect(current.map((c) => c.dataset.testid)).toEqual(['filter-all']);
  });

  it('⚠⚠ no two chips draw the same glyph', async () => {
    /*
     * Instagram fell back to the globe, and in a row of five channels that put
     * two identical globes side by side meaning two different things.
     */
    render(await ConversationList({ rows: queue(), cap: 10, now: NOW, hasMore: false }));
    const glyphs = QUEUE_CHANNEL_FILTERS.map(
      (id) => screen.getByTestId(`filter-${id}`).querySelector('svg')?.innerHTML,
    );
    expect(new Set(glyphs).size).toBe(QUEUE_CHANNEL_FILTERS.length);
    expect(
      screen.getByTestId('filter-INSTAGRAM').querySelector('[data-glyph="instagram"]'),
    ).not.toBeNull();
  });

  it('⚠ "Filters" is absent - its panel does not exist', async () => {
    render(await ConversationList({ rows: queue(), cap: 10, now: NOW, hasMore: false }));
    expect(screen.getByTestId('queue-filters').textContent).not.toMatch(/filters/i);
  });

  it('⚠⚠ a row keeps the view and the channel when it opens a conversation', async () => {
    render(
      await ConversationList({
        rows: queue(),
        cap: 10,
        now: NOW,
        hasMore: false,
        view: 'resolved',
        channel: 'WHATSAPP',
      }),
    );
    const first = params(rowLinks()[0]!);
    expect(first.get('c')).toBe('c1');
    expect(first.get('view')).toBe('resolved');
    expect(first.get('channel')).toBe('WHATSAPP');
  });

  it('★ an empty filtered list says it is the filter, not that nothing waits', async () => {
    render(
      await ConversationList({ rows: [], cap: 10, now: NOW, hasMore: false, channel: 'WEBCHAT' }),
    );
    expect(screen.getByTestId('queue-empty').textContent).toBe(messages.queue.filter.emptyFiltered);
  });
});

describe('★ the list hands the menu what it needs', () => {
  it('⚠ the rows are inside the menu’s area, carrying their ids', async () => {
    render(
      await ConversationList({
        rows: [row({ id: 'c1' })],
        cap: 10,
        now: NOW,
        hasMore: false,
        meId: 'me',
        role: 'ADMIN',
        colleagues: [],
        greeting: null,
      }),
    );
    const area = screen.getByTestId('queue-menu-area');
    expect(area.querySelector('[data-conversation-id="c1"]')).not.toBeNull();
  });
});

describe('★ 02b - on a clear queue the bar at the column’s foot carries what the queue is', () => {
  it('one foot, the sentence, in the bar - never an empty band', async () => {
    render(
      await ConversationList({
        rows: [],
        cap: 50,
        now: NOW,
        hasMore: false,
        clear: <div>clear</div>,
      }),
    );
    expect(screen.getByTestId('queue-cap')).toHaveTextContent(
      'New conversations land here unless an automation is running them.',
    );
    expect(screen.getAllByText(/New conversations land here/)).toHaveLength(1);
  });

  it('a busy queue keeps its count', async () => {
    render(
      await ConversationList({ rows: [row()], cap: 10, now: NOW, hasMore: false, clear: null }),
    );
    expect(screen.getByTestId('queue-cap')).toHaveTextContent(/that's all of them/i);
  });
});
