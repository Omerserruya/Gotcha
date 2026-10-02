import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import {
  aiPerformanceSchema,
  analyticsOverviewSchema,
  timeSavedSchema,
} from '@/api/contracts/analytics';
import { toolUsageSchema } from '@/api/contracts/capabilities';
import { integrationSchema } from '@/api/contracts/integrations';
import analytics from '@/i18n/messages/en/analytics.json';

vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: { pathname: string };
    children: React.ReactNode;
  }) => (
    <a href={href.pathname} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'analytics') =>
    createTranslator({ locale: 'en', messages: { analytics }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
}));

import {
  AloneChart,
  failedCount,
  failuresByDownConnection,
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
  overview: analyticsOverviewSchema.parse({
    totalConversations: 2830,
    aiHandledCount: 2490,
    aiHandledPct: 88,
  }),
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
  integrations: null,
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

  it('⚠ where it stopped: approval and not-known counted; a person asked for, said as not counted', async () => {
    render(await WhereStopped({ data: data() }));
    expect(screen.getByTestId('stopped-approval')).toHaveTextContent('54 needed your approval.');
    expect(screen.getByTestId('stopped-unknown')).toHaveTextContent("1 it didn't know");
    // Measured: "— asked for a person outright." A dash mid-sentence does not read.
    expect(screen.getByTestId('stopped-person')).toHaveTextContent(
      "Asking for a person outright isn't counted yet.",
    );
  });

  it('★★ no dash inside a sentence — a figure it could not read gets its own sentence', async () => {
    render(await WhereStopped({ data: data({ ai: null, unanswered: null }) }));
    expect(screen.getByTestId('stopped-unknown')).toHaveTextContent(
      "We couldn't count what it didn't know just now.",
    );
    expect(screen.getByTestId('stopped-approval')).toHaveTextContent(
      "We couldn't count what needed your approval just now.",
    );
    expect(screen.getByTestId('gotcha-stopped')).not.toHaveTextContent('—');
  });

  it('★★ nor in the foot of what it did, when failures are not split for every tool', async () => {
    const tools = data().tools!.map((tool) => ({ ...tool, erroredCount: undefined }));
    render(await WhatItDid({ tools }));
    expect(screen.getByTestId('did-foot')).not.toHaveTextContent('—');
    expect(screen.getByTestId('did-foot')).toHaveTextContent(
      "3 were stopped by a rule, which is the rule working. Failures aren't told apart",
    );
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
        data: {
          overview: null,
          timeSaved: null,
          tools: null,
          ai: null,
          unanswered: null,
          integrations: null,
        },
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

describe('★★ measured on dev: 977 actions, 441 failed, all of them Shopify on a revoked token', () => {
  const shopify = (status: string, lastError: string | null) =>
    integrationSchema.parse({
      id: 'i1',
      slug: 'shopify',
      name: 'Shopify',
      authType: 'OAUTH2',
      tenantConnection: { id: 'c1', status, lastError },
    });
  const failing = [
    tool({
      toolName: 'shopify.get_customer_by_phone',
      executionCount: 825,
      erroredCount: 400,
      unclassifiedFailureCount: 0,
    }),
    tool({
      toolName: 'shopify.lookup_order',
      executionCount: 152,
      erroredCount: 41,
      unclassifiedFailureCount: 0,
    }),
  ];

  it('★★ every failure on a tool of the down connection: one cause, said, with the way to fix it', async () => {
    render(
      await WhatItDid({
        tools: failing,
        integrations: [shopify('ERROR', 'token_refresh_failed: shopify_token_refresh_failed_401')],
      }),
    );
    const cause = screen.getByTestId('did-cause');
    expect(cause).toHaveTextContent(
      'All 441 failures were Shopify actions, and the Shopify connection is down.',
    );
    expect(screen.getByTestId('did-reconnect')).toHaveAttribute('href', '/settings/systems');
    expect(screen.queryByTestId('did-foot')).toBeNull();
  });

  it('some of them: says how many', () => {
    expect(
      failuresByDownConnection(
        [
          ...failing,
          tool({
            toolName: 'stripe.refund',
            executionCount: 5,
            erroredCount: 9,
            unclassifiedFailureCount: 0,
          }),
        ],
        [shopify('ERROR', 'token_refresh_failed')],
      ),
    ).toEqual({ name: 'Shopify', count: 441, total: 450 });
  });

  it('some of them, on the screen: how many of how many', async () => {
    render(
      await WhatItDid({
        tools: [
          ...failing,
          tool({
            toolName: 'stripe.refund',
            executionCount: 5,
            erroredCount: 9,
            unclassifiedFailureCount: 0,
          }),
        ],
        integrations: [shopify('ERROR', 'token_refresh_failed')],
      }),
    );
    expect(screen.getByTestId('did-cause')).toHaveTextContent(
      '441 of the 450 failures were Shopify actions, and the Shopify connection is down.',
    );
  });

  it('a connection in ERROR with no error text: down all the same', () => {
    expect(failuresByDownConnection(failing, [shopify('ERROR', null)])?.count).toBe(441);
  });

  it('a connection still CONNECTED but whose last error is the token: down', () => {
    expect(
      failuresByDownConnection(failing, [shopify('CONNECTED', 'oauth token expired')])?.count,
    ).toBe(441);
  });

  it('⚠ a healthy connection is no cause — the plain foot stays', async () => {
    render(await WhatItDid({ tools: failing, integrations: [shopify('CONNECTED', null)] }));
    expect(screen.queryByTestId('did-cause')).toBeNull();
    expect(screen.getByTestId('did-foot')).toHaveTextContent('441 failed');
  });

  it('no failures, no cause', () => {
    expect(
      failuresByDownConnection(
        [
          tool({
            toolName: 'shopify.x',
            executionCount: 3,
            erroredCount: 0,
            unclassifiedFailureCount: 0,
          }),
        ],
        [shopify('ERROR', 'token_refresh_failed')],
      ),
    ).toBeNull();
  });

  it('★ no conversations: "—", never "0%" — no percentage of nothing', async () => {
    render(
      await GotchaStrip({
        data: data({
          overview: analyticsOverviewSchema.parse({ totalConversations: 0, aiHandledPct: 0 }),
        }),
      }),
    );
    expect(screen.getByTestId('gotcha-alone')).toHaveTextContent('—');
    expect(screen.getByTestId('gotcha-alone')).not.toHaveTextContent('0%');
  });
});
