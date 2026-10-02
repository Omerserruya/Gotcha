import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { analyticsOverviewSchema, insightSchema, type Insight } from '@/api/contracts/analytics';
import analytics from '@/i18n/messages/en/analytics.json';
import channels from '@/i18n/messages/en/channels.json';
import home from '@/i18n/messages/en/home.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({
      locale: 'en',
      messages: { analytics, channels, home },
      namespace: namespace as never,
    }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
}));

import { KpiStrip, WhatChanged } from './OperationSummary';

const insight = (id: string, impact: string, over: Record<string, unknown> = {}): Insight =>
  insightSchema.parse({
    id,
    kind: 'escalation.rate_high',
    impact,
    values: { percent: 43, days: 7, escalated: 13, analyzed: 30 },
    ...over,
  });

describe('★★ "What changed" — the strongest finding, in Home’s own words', () => {
  it('★★ leads with the highest-impact insight', async () => {
    render(
      await WhatChanged({
        insights: [
          insight('low', 'low'),
          insight('top', 'high', { values: { percent: 61, days: 7, escalated: 1, analyzed: 2 } }),
        ],
      }),
    );
    expect(screen.getByTestId('what-changed')).toHaveTextContent('61%');
  });

  it('★ the rest are "Also worth a look", at most three', async () => {
    render(
      await WhatChanged({
        insights: ['a', 'b', 'c', 'd', 'e'].map((id) => insight(id, 'medium')),
      }),
    );
    expect(screen.getByTestId('also-worth').querySelectorAll('li')).toHaveLength(3);
  });

  it('⚠ nothing standing out is said, and a failed read is not "nothing"', async () => {
    const { unmount } = render(await WhatChanged({ insights: [] }));
    expect(screen.getByTestId('what-changed')).toHaveTextContent(/Nothing stands out/);
    unmount();
    render(await WhatChanged({ insights: null }));
    expect(screen.getByTestId('what-changed')).toHaveTextContent(/couldn't read/);
  });
});

describe('★★ the strip — and a delta only where the platform computes one', () => {
  const overview = analyticsOverviewSchema.parse({
    totalConversations: 2840,
    aiHandledPct: 88,
    resolutionRate: 94,
    avgResponseTimeMs: 42_000,
    deltas: { totalConversationsPct: 12 },
  });

  it('★ the five figures', async () => {
    render(await KpiStrip({ overview, timeSaved: { secondsSaved: 41 * 3600 } as never }));
    expect(screen.getByTestId('kpi-conversations')).toHaveTextContent('2,840');
    expect(screen.getByTestId('kpi-handledByGotcha')).toHaveTextContent('88%');
    expect(screen.getByTestId('kpi-resolved')).toHaveTextContent('94%');
    expect(screen.getByTestId('kpi-avgReply')).toHaveTextContent('42s');
    expect(screen.getByTestId('kpi-timeSaved')).toHaveTextContent('41h');
  });

  it('★★ +12% on conversations — the one delta `overview` returns', async () => {
    render(await KpiStrip({ overview, timeSaved: null }));
    expect(screen.getByTestId('kpi-conversations')).toHaveTextContent('+12%');
  });

  it('⚠⚠ and no invented delta — not "flat", not a dash — on the four it does not', async () => {
    render(await KpiStrip({ overview, timeSaved: null }));
    for (const key of ['handledByGotcha', 'resolved', 'avgReply', 'timeSaved']) {
      const cell = screen.getByTestId(`kpi-${key}`);
      // Not even a zero: no delta element at all where none was measured.
      expect(cell.querySelector('[data-direction]'), key).toBeNull();
      expect(cell.textContent).not.toMatch(/[+−]|flat/);
    }
  });

  it('⚠ a period with no prior period has no delta at all', async () => {
    render(
      await KpiStrip({
        overview: { ...overview, deltas: { totalConversationsPct: null } },
        timeSaved: null,
      }),
    );
    expect(screen.getByTestId('kpi-conversations').textContent).not.toMatch(/%/);
  });

  it('⚠ an unread week says so, rather than five zeroes', async () => {
    render(await KpiStrip({ overview: null, timeSaved: null }));
    expect(screen.getByTestId('kpi-unavailable')).toBeInTheDocument();
  });
});
