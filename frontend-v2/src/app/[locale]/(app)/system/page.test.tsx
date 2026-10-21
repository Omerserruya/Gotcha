import { render, screen } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import consoleEn from '@/i18n/messages/en/console.json';
import navigation from '@/i18n/messages/en/navigation.json';
import { CONSOLE_SECTIONS } from '@/shell/navigation';

/** The console's home and its layout: behind the door, and listing what exists. */
const door = vi.hoisted(() => ({ open: true }));
vi.mock('@/shell/require-console', () => ({
  requireConsole: async () => {
    if (!door.open) throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'console') =>
    createTranslator({ locale: 'en', messages: { console: consoleEn, navigation }, namespace }),
}));
vi.mock('@/i18n/navigation', () => ({
  usePathname: () => '/system',
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { default: Page } = await import('./page');
const { default: Layout } = await import('./layout');

const show = (node: ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ console: consoleEn, navigation }}>
      {node}
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  door.open = true;
});

describe('★★ /system - the console’s home', () => {
  it('★ says what the console is', async () => {
    show(await Page());
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Platform console');
  });

  it('★ lists exactly the sections that exist, each a link', async () => {
    show(await Page());
    const links = screen.queryAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual(
      CONSOLE_SECTIONS.map((section) => section.href),
    );
  });

  it('★★ not a system admin: the page draws nothing, it is not found', async () => {
    door.open = false;
    await expect(Page()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('★★ and the layout draws no frame of the console either', async () => {
    door.open = false;
    await expect(Layout({ children: <p>secret</p> })).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('a system admin gets the frame: the sections and the page', async () => {
    show(await Layout({ children: <p data-testid="inside">page</p> }));
    expect(screen.getByRole('navigation', { name: 'Console' })).toBeInTheDocument();
    expect(screen.getByTestId('inside')).toBeInTheDocument();
  });
});
