import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import channels from '@/i18n/messages/en/channels.json';
import inbox from '@/i18n/messages/en/inbox.json';

import { closeTarget, InboxEscape } from './InboxEscape';
import type { WallHistory } from './wall/load-wall';
import { WallBody } from './wall/WallBody';

/**
 * Esc closes the conversation being read (Omer: "much like WhatsApp") - and
 * only when nothing on top of it owns the key.
 */
const replace = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  usePathname: () => '/en/inbox',
}));
vi.mock('./wall/wall-actions', () => ({ conversationMessages: vi.fn() }));

const esc = (init: KeyboardEventInit = {}) =>
  act(() => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init }),
    );
  });

const wrap = (node: ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ inbox, channels }}>
      {node}
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  replace.mockClear();
  window.history.replaceState(null, '', '/en/inbox?view=mine&c=c1&channel=WHATSAPP');
  document.body.focus();
});

describe('★★ Esc closes the conversation', () => {
  it('★★ ?c= goes; the view and the rest stay', () => {
    wrap(<InboxEscape conversationId="c1" />);
    esc();
    expect(replace).toHaveBeenCalledWith('/en/inbox?view=mine&channel=WHATSAPP', {
      scroll: false,
    });
  });

  it('nothing else in the address: the bare inbox', () => {
    expect(closeTarget('?c=c1')).toBe('');
  });

  it('★★ a focused field with text: blurred, the text kept - not closed', () => {
    wrap(
      <>
        <InboxEscape conversationId="c1" />
        <textarea data-testid="box" defaultValue="Half a reply" />
      </>,
    );
    const box = screen.getByTestId('box');
    box.focus();
    esc();
    expect(replace).not.toHaveBeenCalled();
    expect(box).not.toHaveFocus();
    expect(box).toHaveValue('Half a reply');
    // The next Esc closes; the composer keeps the draft per conversation.
    esc();
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('★★ an open menu owns Esc: the conversation stays', () => {
    wrap(
      <>
        <InboxEscape conversationId="c1" />
        <div role="menu">a menu</div>
      </>,
    );
    esc();
    expect(replace).not.toHaveBeenCalled();
  });

  it.each(['dialog', 'alertdialog', 'listbox'])('and so does an open %s', (role) => {
    wrap(
      <>
        <InboxEscape conversationId="c1" />
        <div role={role}>on top</div>
      </>,
    );
    esc();
    expect(replace).not.toHaveBeenCalled();
  });

  it('an input method mid-composition: nothing', () => {
    wrap(<InboxEscape conversationId="c1" />);
    esc({ isComposing: true });
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('★★ in the history drill, Esc is Back - one level, and the conversation stays', () => {
  const conv = (id: string) => ({
    id,
    channel: 'WHATSAPP',
    status: 'OPEN',
    startedAt: null,
    lastAt: null,
    messages: 1,
    summary: `Summary ${id}`,
    isCurrent: false,
  });
  const history: WallHistory = { total: 2, hasMore: false, conversations: [conv('a'), conv('b')] };

  it('level 2 → level 1 → the wall, and no close on the way', () => {
    wrap(
      <>
        <InboxEscape conversationId="c1" />
        <WallBody history={history} why="">
          <p data-testid="wall-child">wall</p>
        </WallBody>
      </>,
    );
    fireEvent.click(screen.getByTestId('wall-history'));
    fireEvent.click(screen.getByTestId('wall-history-a'));
    expect(screen.getByTestId('wall-drill')).toHaveAttribute('data-level', 'summary');

    esc();
    expect(screen.getByTestId('wall-drill')).toHaveAttribute('data-level', 'list');
    esc();
    expect(screen.getByTestId('wall-child')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();

    // On the wall itself, Esc is the inbox's again.
    esc();
    expect(replace).toHaveBeenCalledTimes(1);
  });
});
