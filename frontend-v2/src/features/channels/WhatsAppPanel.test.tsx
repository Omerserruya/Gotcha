import { act, fireEvent, render as rtlRender, screen } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import channels from '@/i18n/messages/en/channels.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'channels.whatsapp') =>
    createTranslator({ locale: 'en', messages: { channels }, namespace }),
}));
/** An href as the browser gets it. */
const hrefOf = (href: unknown) => {
  if (typeof href === 'string') return href;
  const { pathname, query } = href as { pathname: string; query?: Record<string, string> };
  const q = new URLSearchParams(query ?? {}).toString();
  return q ? `${pathname}?${q}` : pathname;
};
const replace = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    replace: _replace,
    scroll: _scroll,
    ...rest
  }: {
    href: unknown;
    children?: ReactNode;
    replace?: boolean;
    scroll?: boolean;
  }) => (
    <a href={hrefOf(href)} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
}));

const actions = vi.hoisted(() => ({ refreshNumber: vi.fn(), disconnectNumber: vi.fn() }));
vi.mock('./number-actions', () => actions);

import { WhatsAppPanel } from './WhatsAppPanel';

const render = (node: ReactElement) =>
  rtlRender(
    <NextIntlClientProvider locale="en" messages={{ channels }}>
      {node}
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  replace.mockReset();
  actions.refreshNumber.mockReset();
  actions.disconnectNumber.mockReset();
});

describe('★ 13b is a panel over Channels', () => {
  it('its head and its way back', async () => {
    render(await WhatsAppPanel({ line: 'One number', children: <p>numbers here</p> }));
    const panel = screen.getByTestId('whatsapp-panel');
    expect(panel).toHaveTextContent('WhatsApp');
    expect(panel).toHaveTextContent('One number');
    expect(screen.getByTestId('whatsapp-close')).toHaveAttribute('href', '/settings/channels');
    expect(panel).toHaveTextContent('numbers here');
  });
});

describe('★★ its tabs are real (Omer, 2026-10-07: they were text that did nothing)', () => {
  it('a tablist of four; the open one selected; each a link to its ?tab=', async () => {
    render(await WhatsAppPanel({ line: 'x', tab: 'contacts', children: <p>contacts</p> }));
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual([
      'Numbers',
      'Templates',
      'Private contacts',
      'Activity',
    ]);
    expect(screen.getByRole('tab', { selected: true })).toHaveTextContent('Private contacts');
    expect(screen.getByRole('tab', { name: 'Templates' })).toHaveAttribute(
      'href',
      '/settings/channels?panel=whatsapp&tab=templates',
    );
    expect(screen.getByRole('tab', { name: 'Numbers' })).toHaveAttribute(
      'href',
      '/settings/channels?panel=whatsapp',
    );
    // Not a disabled-looking label: none of them is aria-disabled.
    for (const tab of tabs) expect(tab).not.toHaveAttribute('aria-disabled');
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', 'whatsapp-tab-contacts');
  });

  it('the keyboard: → the next tab, End the last - replaced in the URL, not pushed', async () => {
    render(await WhatsAppPanel({ line: 'x', tab: 'numbers', children: <p>n</p> }));
    const list = screen.getByRole('tablist');
    act(() => {
      fireEvent.keyDown(list, { key: 'ArrowRight' });
    });
    expect(replace).toHaveBeenLastCalledWith(
      { pathname: '/settings/channels', query: { panel: 'whatsapp', tab: 'templates' } },
      { scroll: false },
    );
    act(() => {
      fireEvent.keyDown(list, { key: 'End' });
    });
    expect(replace).toHaveBeenLastCalledWith(
      { pathname: '/settings/channels', query: { panel: 'whatsapp', tab: 'activity' } },
      { scroll: false },
    );
  });

  it('the foot with no number on record (dev): Activity log opens its tab; the other two are a status, saying why', async () => {
    render(await WhatsAppPanel({ line: 'x', children: <p>n</p> }));
    expect(screen.getByTestId('whatsapp-foot-activity')).toHaveAttribute(
      'href',
      '/settings/channels?panel=whatsapp&tab=activity',
    );
    for (const id of ['whatsapp-foot-refresh', 'whatsapp-foot-disconnect']) {
      const foot = screen.getByTestId(id);
      expect(foot.tagName).not.toBe('BUTTON');
      expect(foot).toHaveAttribute('aria-disabled', 'true');
      expect(foot).toHaveTextContent('Not available yet');
      expect(foot).toHaveTextContent("isn't fully set up in GOTCHA");
    }
    const panel = screen.getByTestId('whatsapp-panel');
    for (const words of ['Refresh from Meta', 'Activity log', 'Disconnect this number']) {
      expect(panel).toHaveTextContent(words);
    }
  });
});

describe('★★ the foot, live where a route is (Omer, 2026-10-07: no dead buttons)', () => {
  const ONE = [{ id: 'n1', phoneNumber: '+972 54 000 0000' }];

  it('Refresh from Meta: busy while it runs, then "Updated just now"', async () => {
    let finish: (v: unknown) => void = () => undefined;
    actions.refreshNumber.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    render(await WhatsAppPanel({ line: 'x', numbers: ONE, children: <p>n</p> }));
    const button = screen.getByTestId('whatsapp-foot-refresh');
    await act(async () => {
      fireEvent.click(button);
    });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveTextContent('Refreshing');
    await act(async () => {
      finish({ ok: true });
    });
    expect(actions.refreshNumber).toHaveBeenCalledWith('n1');
    expect(screen.getByTestId('whatsapp-foot-refresh-result')).toHaveTextContent(
      'Updated just now',
    );
  });

  it('Refresh refused: in words, not a code', async () => {
    actions.refreshNumber.mockResolvedValue({ ok: false, reason: 'failed' });
    render(await WhatsAppPanel({ line: 'x', numbers: ONE, children: <p>n</p> }));
    await act(async () => {
      fireEvent.click(screen.getByTestId('whatsapp-foot-refresh'));
    });
    expect(screen.getByTestId('whatsapp-foot-refresh-result')).toHaveTextContent(
      "Couldn't reach Meta just now",
    );
  });

  it('★ Disconnect: a confirmation naming the number and saying what goes and what stays; nothing until confirmed', async () => {
    actions.disconnectNumber.mockResolvedValue({ ok: true });
    render(await WhatsAppPanel({ line: 'x', numbers: ONE, children: <p>n</p> }));
    fireEvent.click(screen.getByTestId('whatsapp-foot-disconnect'));
    const dialog = screen.getByTestId('whatsapp-disconnect');
    expect(dialog).toHaveTextContent('Disconnect +972 54 000 0000?');
    expect(dialog).toHaveTextContent('stop reaching GOTCHA');
    expect(dialog).toHaveTextContent('conversations you already have are kept');
    expect(actions.disconnectNumber).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByTestId('whatsapp-disconnect-yes'));
    });
    expect(actions.disconnectNumber).toHaveBeenCalledWith('n1');
    expect(replace).toHaveBeenCalledWith('/settings/channels');
  });

  it('Disconnect with several numbers on record: a status - the foot cannot say which', async () => {
    render(
      await WhatsAppPanel({
        line: 'x',
        numbers: [...ONE, { id: 'n2', phoneNumber: '+972 54 111 1111' }],
        children: <p>n</p>,
      }),
    );
    const foot = screen.getByTestId('whatsapp-foot-disconnect');
    expect(foot).toHaveAttribute('aria-disabled', 'true');
    expect(foot).toHaveTextContent('more than one number');
  });
});
