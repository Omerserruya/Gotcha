import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import channels from '@/i18n/messages/en/channels.json';
import home from '@/i18n/messages/en/home.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({
      locale: 'en',
      messages: { home, channels },
      namespace: namespace as 'home',
    }),
  getFormatter: async () => createFormatter({ locale: 'en' }),
}));
vi.mock('server-only', () => ({}));

import { MetricStrip } from './MetricStrip';

const overview = (over: Record<string, number> = {}) =>
  ({
    totalConversations: 0,
    aiHandledCount: 0,
    humanHandledCount: 0,
    aiHandledPct: 0,
    pendingApprovalCount: 0,
    ...over,
  }) as never;

const cell = (label: string) => screen.getByText(label).parentElement!;

describe('★ 01’s strip — no share of nothing', () => {
  it('no conversations today: the count is 0, the shares of it are "—"', async () => {
    render(
      await MetricStrip({
        overview: overview(),
        channels: null,
        pendingApproval: 0,
        isQuiet: false,
      }),
    );
    expect(cell('Conversations today')).toHaveTextContent(/0$/);
    expect(cell('Handled by GOTCHA')).toHaveTextContent(/—$/);
    expect(cell('By your team')).toHaveTextContent(/—$/);
    // Approvals waiting is a count of its own: a true zero.
    expect(cell('Waiting on approval')).toHaveTextContent(/0$/);
  });

  it('with conversations, the numbers are numbers', async () => {
    render(
      await MetricStrip({
        overview: overview({
          totalConversations: 12,
          aiHandledCount: 9,
          humanHandledCount: 3,
          aiHandledPct: 75,
        }),
        channels: null,
        pendingApproval: 0,
        isQuiet: false,
      }),
    );
    expect(cell('Handled by GOTCHA')).toHaveTextContent(/975%$/);
    expect(cell('By your team')).toHaveTextContent(/3$/);
  });
});
