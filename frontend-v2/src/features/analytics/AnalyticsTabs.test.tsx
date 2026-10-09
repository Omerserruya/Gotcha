import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import analytics from '@/i18n/messages/en/analytics.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'analytics') =>
    createTranslator({ locale: 'en', messages: { analytics }, namespace }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: { pathname: string; query?: Record<string, string> };
    children: ReactNode;
  }) => (
    <a href={`${href.pathname}?${new URLSearchParams(href.query ?? {})}`} {...rest}>
      {children}
    </a>
  ),
}));

import { ANALYTICS_TABS, AnalyticsTabs, parseAnalyticsTab } from './AnalyticsTabs';

describe('★ 02’s tabs, now that each leads somewhere', () => {
  it('five, in 02’s order, each a URL; the open one marked', async () => {
    render(await AnalyticsTabs({ current: 'team' }));
    const links = [...screen.getByTestId('analytics-tabs').querySelectorAll('a')];
    expect(links.map((a) => a.textContent)).toEqual([
      'Overview',
      'GOTCHA',
      'Team',
      'Sales',
      'Topics',
    ]);
    expect(screen.getByTestId('analytics-tab-team')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('analytics-tab-overview')).toHaveAttribute('href', '/analytics?');
    expect(screen.getByTestId('analytics-tab-topics')).toHaveAttribute(
      'href',
      '/analytics?tab=topics',
    );
  });

  it('an unknown tab is the overview', () => {
    expect(parseAnalyticsTab('nope')).toBe('overview');
    expect(ANALYTICS_TABS.map(parseAnalyticsTab)).toEqual([...ANALYTICS_TABS]);
  });
});
