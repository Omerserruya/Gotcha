import { act, fireEvent, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
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
  useRouter: () => ({ replace, push: vi.fn() }),
}));

import { WhatsAppPanel } from './WhatsAppPanel';

beforeEach(() => {
  replace.mockReset();
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

  it('the foot: Activity log opens the Activity tab; the two not wired are a status', async () => {
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
    }
    const panel = screen.getByTestId('whatsapp-panel');
    for (const words of ['Refresh from Meta', 'Activity log', 'Disconnect this number']) {
      expect(panel).toHaveTextContent(words);
    }
  });
});
