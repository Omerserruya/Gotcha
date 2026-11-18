import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import consoleEn from '@/i18n/messages/en/console.json';
import navigationEn from '@/i18n/messages/en/navigation.json';

/**
 * ★★ The console sidebar: every section, the AI failures among them, and
 * a count beside a section only when the layout read one above 0.
 */
vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    prefetch: _p,
    ...rest
  }: {
    href: string;
    children: ReactNode;
    prefetch?: boolean;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  usePathname: () => '/system/ai-failures',
}));

import { ConsoleSections } from './ConsoleSections';

const show = (badges?: Record<string, number>) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ console: consoleEn, navigation: navigationEn }}>
      <ConsoleSections badges={badges} />
    </NextIntlClientProvider>,
  );

describe('★★ ConsoleSections', () => {
  it('lists "Failed AI actions" as the sixth section, current on its page', () => {
    show();
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(6);
    expect(links[5]).toHaveTextContent(consoleEn.sections.aiFailures);
    expect(links[5]).toHaveAttribute('href', '/system/ai-failures');
    expect(links[5]).toHaveAttribute('aria-current', 'page');
  });

  it('★ a count above 0 is drawn beside its section, named for a screen reader', () => {
    show({ 'ai-failures': 3 });
    const badge = screen.getByTestId('console-badge-ai-failures');
    expect(badge).toHaveTextContent('3');
    expect(badge).toHaveAttribute('aria-hidden', 'true');
    // Read as words, with the section's name, never as a bare number.
    expect(screen.getByRole('link', { name: /Failed AI actions/ })).toHaveAccessibleName(
      /^Failed AI actions\s*3 failure groups over the threshold in the last hour$/,
    );
  });

  it.each([undefined, {}, { 'ai-failures': 0 }] as (Record<string, number> | undefined)[])(
    'no count, or 0, draws nothing (%j)',
    (badges) => {
      show(badges);
      expect(screen.queryByTestId('console-badge-ai-failures')).toBeNull();
    },
  );
});
