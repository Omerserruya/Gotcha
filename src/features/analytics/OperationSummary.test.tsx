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

describe('★★ "What changed" holds only a CHANGE — and today the platform emits none', () => {
  it('⚠⚠ a standing fact is not drawn as a change — no dark card at all', async () => {
    // "68 conversations came through WhatsApp in the last 30 days" sat over a
    // strip reading 0 for the week. It is a level, not a change.
    render(
      await WhatChanged({
        insights: [
          insight('top', 'high', {
            kind: 'channel.highest_volume',
            values: { count: 68, channel: 'WHATSAPP', days: 30 },
          }),
        ],
      }),
    );
    expect(screen.queryByTestId('what-changed')).toBeNull();
  });

  it('★ standing facts are "Also worth a look", strongest first, each naming its own period', async () => {
    render(
      await WhatChanged({
        insights: [
          insight('low', 'low'),
          insight('top', 'high', { values: { percent: 61, days: 30, escalated: 1, analyzed: 2 } }),
        ],
      }),
    );
    const list = screen.getByTestId('also-worth');
    expect(list.querySelector('li')).toHaveTextContent('61%');
    expect(list.querySelector('li')).toHaveTextContent('in the last 30 days');
  });

  it('★ at most three', async () => {
    render(
      await WhatChanged({ insights: ['a', 'b', 'c', 'd', 'e'].map((id) => insight(id, 'medium')) }),
    );
    expect(screen.getByTestId('also-worth').querySelectorAll('li')).toHaveLength(3);
  });

  it('⚠ nothing to say draws nothing, and a failed read says it failed', async () => {
    const { container, unmount } = render(await WhatChanged({ insights: [] }));
    expect(container.textContent).toBe('');
    unmount();
    render(await WhatChanged({ insights: null }));
    expect(screen.getByTestId('insights-unavailable')).toHaveTextContent(/couldn't read/);
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

describe('⚠⚠ a share of nothing is "—", not 0%', () => {
  it('no conversations in the week: no percentage, and no time saved', async () => {
    const empty = analyticsOverviewSchema.parse({
      totalConversations: 0,
      aiHandledPct: 0,
      resolutionRate: 0,
    });
    render(await KpiStrip({ overview: empty, timeSaved: { secondsSaved: 0 } as never }));
    for (const key of ['handledByGotcha', 'resolved', 'timeSaved']) {
      const cell = screen.getByTestId(`kpi-${key}`);
      expect(cell, key).toHaveTextContent('—');
      expect(cell.textContent, key).not.toMatch(/0%|0s/);
    }
  });
});
