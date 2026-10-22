import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/channels.json';

const selectMessengerPages = vi.hoisted(() => vi.fn());
const startChannelConnect = vi.hoisted(() => vi.fn());
vi.mock('./messenger-actions', () => ({ selectMessengerPages }));
vi.mock('./actions', () => ({ startChannelConnect }));
const replace = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ replace, refresh }) }));

import { MessengerPicker } from './MessengerPicker';
import type { MessengerPagesRead } from './messenger-actions';

const assign = vi.fn();
beforeEach(() => {
  selectMessengerPages.mockReset();
  startChannelConnect.mockReset();
  replace.mockReset();
  refresh.mockReset();
  assign.mockReset();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign },
  });
});

const PAGES = [
  { id: 'p1', name: 'Shop', category: 'Retail', connectedHere: false, takenElsewhere: false },
  { id: 'p2', name: 'Cafe', category: null, connectedHere: true, takenElsewhere: false },
  { id: 'p3', name: 'Elsewhere', category: null, connectedHere: false, takenElsewhere: true },
];
const show = (read: MessengerPagesRead) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ channels: messages }}>
      <MessengerPicker pick={{ session: 's1', read }} />
    </NextIntlClientProvider>,
  );
const choose = async (...ids: string[]) => {
  for (const id of ids) await userEvent.click(screen.getByTestId(`messenger-pick-${id}`));
};

describe('★★ choosing the Pages', () => {
  it('lists every Page; another workspace’s is said and has no checkbox; the URL is tidied', () => {
    show({ ok: true, pages: PAGES });
    expect(screen.getByTestId('messenger-page-p1')).toHaveTextContent('Shop');
    expect(screen.getByTestId('messenger-page-p1')).toHaveTextContent('Retail');
    expect(screen.getByTestId('messenger-page-p2')).toHaveTextContent(
      'Already connected here. Choosing it reconnects it.',
    );
    expect(screen.getByTestId('messenger-page-p3')).toHaveTextContent(
      "Connected to another GOTCHA workspace, so it can't be connected here.",
    );
    expect(screen.queryByTestId('messenger-pick-p3')).toBeNull();
    expect(screen.getByTestId('messenger-pick-p2')).not.toBeChecked();
    expect(replace).toHaveBeenCalledWith('/settings/channels', { scroll: false });
  });

  it('★ nothing chosen: no Connect, a sentence instead; choosing offers it with the count', async () => {
    show({ ok: true, pages: PAGES });
    expect(screen.queryByTestId('messenger-pick-confirm')).toBeNull();
    expect(screen.getByTestId('messenger-pick-hint')).toHaveTextContent(
      'Choose at least one Page to connect.',
    );
    await choose('p1');
    expect(screen.getByTestId('messenger-pick-confirm')).toHaveTextContent('Connect 1 Page');
    await choose('p2');
    expect(screen.getByTestId('messenger-pick-confirm')).toHaveTextContent('Connect 2 Pages');
    await choose('p1', 'p2');
    expect(screen.queryByTestId('messenger-pick-confirm')).toBeNull();
  });

  it('★ every Page another workspace’s: said, and nothing offered', () => {
    show({ ok: true, pages: [PAGES[2]!] });
    expect(screen.getByTestId('messenger-pick-none')).toHaveTextContent(
      'Every Page from this sign-in is connected to another GOTCHA workspace',
    );
    expect(screen.queryByTestId('messenger-pick-confirm')).toBeNull();
    expect(screen.queryByTestId('messenger-pick-hint')).toBeNull();
  });

  it('★★ Connect sends exactly the chosen ids, then says what happened to each, and refreshes', async () => {
    selectMessengerPages.mockResolvedValue({
      ok: true,
      results: [
        { id: 'p1', name: 'Shop', status: 'connected', subscribed: true },
        { id: 'p2', name: 'Cafe', status: 'reconnected', subscribed: false },
        { id: 'p4', name: 'Odd', status: 'unknown', subscribed: null },
        { id: 'p5', name: 'Gone', status: 'taken', subscribed: false },
      ],
    });
    show({ ok: true, pages: PAGES });
    await choose('p1', 'p2');
    await userEvent.click(screen.getByTestId('messenger-pick-confirm'));
    expect(selectMessengerPages).toHaveBeenCalledWith('s1', ['p1', 'p2']);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('messenger-pick-pages')).toBeNull();
    const row = (id: string) => screen.getByTestId(`messenger-result-${id}`);
    expect(row('p1')).toHaveTextContent('ShopConnected.');
    expect(row('p1')).toHaveAttribute('data-outcome', 'ok');
    expect(row('p2')).toHaveTextContent(
      "Reconnected, but messages can't arrive: the platform refused GOTCHA's subscription to them.",
    );
    expect(row('p2')).toHaveAttribute('data-outcome', 'problem');
    expect(row('p4')).toHaveTextContent("Its answer couldn't be read.");
    expect(row('p5')).toHaveTextContent(
      "Not connected: it's connected to another GOTCHA workspace.",
    );
    await userEvent.click(screen.getByTestId('messenger-pick-done'));
    expect(screen.queryByTestId('messenger-pick')).toBeNull();
  });

  it('a new Page whose subscription was refused says so; connected and subscribed says "Connected."', async () => {
    selectMessengerPages.mockResolvedValue({
      ok: true,
      results: [{ id: 'p1', name: 'Shop', status: 'connected', subscribed: false }],
    });
    show({ ok: true, pages: PAGES });
    await choose('p1');
    await userEvent.click(screen.getByTestId('messenger-pick-confirm'));
    expect(screen.getByTestId('messenger-result-p1')).toHaveTextContent(
      "Connected, but messages can't arrive",
    );
  });
});

describe('★★ each refusal in words', () => {
  it.each([
    [
      'limit',
      'Your plan has no room for that many new channels. Choose fewer new Pages',
      { list: true, again: false },
    ],
    [
      'unknown_page',
      "Some of those Pages weren't part of this sign-in.",
      { list: true, again: true },
    ],
    ['forbidden', "You don't have permission to connect a channel.", { list: true, again: false }],
    ['failed', "Those Pages didn't connect. Try again.", { list: true, again: false }],
    ['expired', 'This choice has expired. Connect Messenger again', { list: false, again: true }],
  ] as const)('%s', async (reason, words, { list, again }) => {
    selectMessengerPages.mockResolvedValue({ ok: false, reason, results: [] });
    show({ ok: true, pages: PAGES });
    await choose('p1');
    await userEvent.click(screen.getByTestId('messenger-pick-confirm'));
    expect(screen.getByTestId('messenger-pick-refused')).toHaveTextContent(words);
    expect(screen.queryByTestId('messenger-pick-pages') !== null).toBe(list);
    expect(screen.queryByTestId('messenger-pick-again') !== null).toBe(again);
    expect(refresh).not.toHaveBeenCalled();
    if (list) {
      // The choice is kept: another try is one press.
      expect(screen.getByTestId('messenger-pick-p1')).toBeChecked();
      expect(screen.getByTestId('messenger-pick-confirm')).toBeInTheDocument();
    }
  });

  it('★ 409 none connected: said, with what happened to each Page', async () => {
    selectMessengerPages.mockResolvedValue({
      ok: false,
      reason: 'none_connected',
      results: [{ id: 'p1', name: 'Shop', status: 'taken', subscribed: false }],
    });
    show({ ok: true, pages: PAGES });
    await choose('p1');
    await userEvent.click(screen.getByTestId('messenger-pick-confirm'));
    expect(screen.getByTestId('messenger-pick-refused')).toHaveTextContent(
      'None of those Pages were connected: each one is connected to another GOTCHA workspace.',
    );
    expect(screen.getByTestId('messenger-result-p1')).toHaveTextContent('Not connected');
  });

  it('★ expired: Connect Messenger again goes to Meta through the usual start', async () => {
    selectMessengerPages.mockResolvedValue({ ok: false, reason: 'expired', results: [] });
    startChannelConnect.mockResolvedValue({ ok: true, url: 'https://www.facebook.com/dialog' });
    show({ ok: true, pages: PAGES });
    await choose('p1');
    await userEvent.click(screen.getByTestId('messenger-pick-confirm'));
    await userEvent.click(screen.getByTestId('messenger-pick-again'));
    expect(startChannelConnect).toHaveBeenCalledWith('MESSENGER');
    expect(assign).toHaveBeenCalledWith('https://www.facebook.com/dialog');
  });
});

describe('★★ the Pages could not be read', () => {
  it.each([
    ['expired', 'This choice has expired. Connect Messenger again to choose your Pages.', true],
    ['failed', "Your Pages couldn't be loaded. Connect Messenger again to choose them.", true],
    ['forbidden', "You don't have permission to connect a channel.", false],
  ] as const)('%s', (reason, words, again) => {
    show({ ok: false, reason });
    expect(screen.getByTestId('messenger-pick-problem')).toHaveTextContent(words);
    expect(screen.queryByTestId('messenger-pick-again') !== null).toBe(again);
    expect(screen.queryByTestId('messenger-pick-confirm')).toBeNull();
  });

  it('the start refused: said, nothing opened', async () => {
    startChannelConnect.mockResolvedValue({ ok: false, reason: 'not_configured' });
    show({ ok: false, reason: 'expired' });
    await userEvent.click(screen.getByTestId('messenger-pick-again'));
    expect(screen.getByTestId('messenger-pick-again-problem')).toHaveTextContent(
      "Messenger isn't set up on GOTCHA's side yet.",
    );
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('the route’s bound, said', () => {
  it('more Pages chosen than one request takes: a sentence with the bound, no Connect', async () => {
    const many = Array.from({ length: 51 }, (_, i) => ({
      id: `m${i}`,
      name: `Page ${i}`,
      category: null,
      connectedHere: false,
      takenElsewhere: false,
    }));
    show({ ok: true, pages: many });
    await choose(...many.map((p) => p.id));
    expect(screen.queryByTestId('messenger-pick-confirm')).toBeNull();
    expect(screen.getByTestId('messenger-pick-hint')).toHaveTextContent(
      'Choose up to 50 Pages at a time.',
    );
  });
});

describe('held once, and closed', () => {
  it('"Not now" ends it, and nothing is sent', async () => {
    show({ ok: true, pages: PAGES });
    await choose('p1');
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByTestId('messenger-pick')).toBeNull();
    expect(selectMessengerPages).not.toHaveBeenCalled();
  });

  it('outlives the tidy (re-rendered with null); Close and "Not now" end it', async () => {
    const { rerender } = show({ ok: true, pages: PAGES });
    rerender(
      <NextIntlClientProvider locale="en" messages={{ channels: messages }}>
        <MessengerPicker pick={null} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId('messenger-pick')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('messenger-pick-close'));
    expect(screen.queryByTestId('messenger-pick')).toBeNull();
  });

  it('nothing to choose: nothing drawn, the URL left alone', () => {
    render(
      <NextIntlClientProvider locale="en" messages={{ channels: messages }}>
        <MessengerPicker pick={null} />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByTestId('messenger-pick')).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });
});
