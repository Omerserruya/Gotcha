import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import {
  aiPerformanceSchema,
  analyticsOverviewSchema,
  timeSavedSchema,
} from '@/api/contracts/analytics';
import { toolUsageSchema } from '@/api/contracts/capabilities';
import analytics from '@/i18n/messages/en/analytics.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'analytics') =>
    createTranslator({ locale: 'en', messages: { analytics }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
}));

import {
  AloneChart,
  failedCount,
  GotchaHero,
  GotchaStrip,
  lastSevenDayDates,
  toolWords,
  WhatItDid,
  WhereStopped,
} from './GotchaTab';
import type { GotchaData } from './load-analytics';

const tool = (over: Record<string, unknown>) =>
  toolUsageSchema.parse({ toolName: 'shopify.lookup_order', executionCount: 10, ...over });

const data = (over: Partial<GotchaData> = {}): GotchaData => ({
  overview: analyticsOverviewSchema.parse({ aiHandledCount: 2490, aiHandledPct: 88 }),
  timeSaved: timeSavedSchema.parse({ secondsSaved: 41 * 3600 }),
  tools: [
    tool({
      toolName: 'shopify.lookup_order',
      executionCount: 904,
      erroredCount: 0,
      unclassifiedFailureCount: 0,
    }),
    tool({
      toolName: 'shopify.process_refund',
      executionCount: 41,
      refusedCount: 3,
      erroredCount: 2,
      unclassifiedFailureCount: 0,
    }),
  ],
  ai: aiPerformanceSchema.parse({ approvals: { requested: 54 } }),
  unanswered: { data: [{ id: 'q1', question: 'Do you ship to Eilat?', askCount: 3 }] },
  ...over,
});

describe('★ the rules', () => {
  it('failed is errored + unclassified; unknown when any tool’s split is missing', () => {
    expect(failedCount([tool({ erroredCount: 2, unclassifiedFailureCount: 1 })])).toBe(3);
    expect(failedCount([tool({ erroredCount: 2 })])).toBeNull();
    expect(failedCount([])).toBe(0);
  });

  it('a tool in words, never its key', () => {
    expect(toolWords('shopify.lookup_order')).toBe('Lookup order');
    expect(toolWords('search_products')).toBe('Search products');
  });

  it('the chart’s axis: seven days, oldest first, ending today', () => {
    const days = lastSevenDayDates(new Date('2026-10-02T12:00:00'));
    expect(days).toHaveLength(7);
    expect(days[6]!.getDate()).toBe(2);
    expect(days[0]!.getDate()).toBe(26);
  });
});

describe('★★ 06b — what GOTCHA did, said as what is recorded', () => {
  it('★★ the dark card says GOTCHA answered FIRST — not that it closed them unread', async () => {
    render(await GotchaHero({ data: data() }));
    const hero = screen.getByTestId('gotcha-hero');
    expect(hero).toHaveTextContent('It answered first in 2,490 conversations.');
    expect(hero).not.toHaveTextContent(/without anyone|closed/i);
    expect(hero).toHaveTextContent('about 41 hours');
  });

  it('⚠ where it stopped: approval and not-known counted; a person asked for "—"', async () => {
    render(await WhereStopped({ data: data() }));
    expect(screen.getByTestId('stopped-approval')).toHaveTextContent('54 needed your approval.');
    expect(screen.getByTestId('stopped-unknown')).toHaveTextContent("1 it didn't know");
    expect(screen.getByTestId('stopped-person')).toHaveTextContent('— asked for a person');
  });

  it('★ a full page of unanswered questions is "50+", never 50', async () => {
    const fifty = Array.from({ length: 50 }, (_, i) => ({
      id: `q${i}`,
      question: 'x',
      askCount: 1,
    }));
    render(await WhereStopped({ data: data({ unanswered: { data: fifty } }) }));
    expect(screen.getByTestId('stopped-unknown')).toHaveTextContent('50+');
  });

  it('the strip: each figure its source; a failed read "—"', async () => {
    const { unmount } = render(await GotchaStrip({ data: data() }));
    expect(screen.getByTestId('gotcha-alone')).toHaveTextContent('88%');
    expect(screen.getByTestId('gotcha-actions')).toHaveTextContent('945');
    expect(screen.getByTestId('gotcha-approval')).toHaveTextContent('54');
    expect(screen.getByTestId('gotcha-failed')).toHaveTextContent('2');
    expect(screen.getByTestId('gotcha-saved')).toHaveTextContent('41h');
    unmount();
    render(
      await GotchaStrip({
        data: { overview: null, timeSaved: null, tools: null, ai: null, unanswered: null },
      }),
    );
    expect(screen.getByTestId('gotcha-strip').textContent?.match(/—/g)).toHaveLength(5);
  });

  it('★ what it did: by tool, in words; failures and refusals said apart', async () => {
    render(await WhatItDid({ tools: data().tools }));
    expect(screen.getByTestId('did-shopify.lookup_order')).toHaveTextContent('Lookup order904');
    expect(screen.getByTestId('did-foot')).toHaveTextContent(
      '2 failed; 3 were stopped by a rule, which is the rule working.',
    );
  });

  it('⚠ a failed read is not "it ran nothing"', async () => {
    const { unmount } = render(await WhatItDid({ tools: null }));
    expect(screen.getByTestId('gotcha-did')).toHaveTextContent("We couldn't read what it ran");
    unmount();
    render(await WhatItDid({ tools: [] }));
    expect(screen.getByTestId('gotcha-did')).toHaveTextContent("It didn't run anything this week.");
  });

  it('the chart: the seven days, and why the bars are empty', async () => {
    render(await AloneChart({ days: lastSevenDayDates(new Date('2026-10-02T12:00:00')) }));
    const chart = screen.getByTestId('gotcha-alone');
    expect(chart.querySelectorAll('li')).toHaveLength(7);
    expect(chart).toHaveTextContent("Nothing splits a day's conversations");
  });
});
