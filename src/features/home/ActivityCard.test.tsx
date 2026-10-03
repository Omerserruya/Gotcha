import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import home from '@/i18n/messages/en/home.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'home.working') =>
    createTranslator({ locale: 'en', messages: { home }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
}));

import { ActivityCard } from './ActivityCard';

const card = async (timeSaved: unknown) =>
  render(
    await ActivityCard({
      events: [],
      timeSaved: timeSaved as never,
      inFlight: null,
      allowance: null,
      now: new Date('2026-10-03T12:00:00Z'),
    }),
  );

const basis = (conversationsHandled: number) => ({
  conversationsHandled,
  secondsPerConversation: 180,
  source: 'platform_default',
  sampleSize: 0,
  method: 'x',
});

describe('★ 01 — time saved is derived from what GOTCHA handled', () => {
  it('nothing handled today: "—", and no basis line', async () => {
    await card({ secondsSaved: 0, basis: basis(0) });
    expect(screen.getByTestId('time-saved')).toHaveTextContent(/^—$/);
    expect(screen.queryByText(/platform average/i)).toBeNull();
  });

  it('handled some: the figure, with its basis', async () => {
    await card({ secondsSaved: 3600, basis: basis(20) });
    expect(screen.getByTestId('time-saved')).not.toHaveTextContent('—');
    expect(screen.getByTestId('time-saved').textContent).toMatch(/1h/);
  });
});
