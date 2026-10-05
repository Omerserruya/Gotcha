import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import {
  analyticsOverviewSchema,
  insightSchema,
  timeSavedSchema,
  type Insight,
} from '@/api/contracts/analytics';
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
  it('⚠⚠ a standing fact is not drawn as a change — the dark card says nothing changed', async () => {
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
    // Drawn in its shape (Omer: every design element is drawn), never with the fact.
    const card = screen.getByTestId('what-changed');
    expect(card).toHaveTextContent('Nothing changed enough to mention this week.');
    expect(card).not.toHaveTextContent('68');
    expect(card).toHaveAttribute('data-empty', '');
    // The fact sits where it belongs.
    expect(screen.getByTestId('also-worth')).toHaveTextContent('68');
  });

  it('nothing at all: both cards drawn, each saying so', async () => {
    render(await WhatChanged({ insights: [] }));
    expect(screen.getByTestId('what-changed')).toHaveTextContent('Nothing changed enough');
    expect(screen.getByTestId('also-worth')).toHaveTextContent('Nothing stands out this week.');
  });

  it('a failed read: the dark card says so, the side card "—"', async () => {
    render(await WhatChanged({ insights: null }));
    expect(screen.getByTestId('what-changed')).toHaveTextContent("We couldn't read what changed");
    expect(screen.getByTestId('insights-unavailable')).toHaveTextContent('—');
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

  it('★ time saved from the platform’s average says it is an estimate; measured says nothing', async () => {
    const saved = (source: string) =>
      timeSavedSchema.parse({
        secondsSaved: 41 * 3600,
        basis: {
          conversationsHandled: 2380,
          secondsPerConversation: 62,
          source,
          sampleSize: 0,
          method: 'x',
        },
      });
    const one = render(await KpiStrip({ overview, timeSaved: saved('platform_default') }));
    expect(
      screen.getByTestId('kpi-timeSaved').querySelector('[title]')?.getAttribute('title'),
    ).toBe(
      'An estimate: 2,380 conversations × the platform’s average of 62s each — not measured in this workspace yet.',
    );
    one.unmount();
    render(await KpiStrip({ overview, timeSaved: saved('measured') }));
    expect(screen.getByTestId('kpi-timeSaved').querySelector('[title]')).toBeNull();
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
