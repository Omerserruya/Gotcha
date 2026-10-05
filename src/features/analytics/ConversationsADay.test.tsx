import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { dailySeriesSchema } from '@/api/contracts/analytics';
import analytics from '@/i18n/messages/en/analytics.json';

vi.mock('@/i18n/navigation', () => ({ Link: 'a' }));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'analytics') =>
    createTranslator({ locale: 'en', messages: { analytics }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Jerusalem' }),
}));

import { AloneChart, ConversationsADay } from './ConversationsADay';
import { lastSevenDayDates } from './GotchaTab';

const FALLBACK = lastSevenDayDates(new Date('2026-10-02T12:00:00'));
/* The route's shape (c054c811): UTC days, oldest first. */
const SERIES = dailySeriesSchema.parse({
  days: 3,
  timezone: 'UTC',
  series: [
    { date: '2026-08-01', gotcha: 25, team: 0, alone: 20, passedOver: 5 },
    { date: '2026-08-02', gotcha: 43, team: 7, alone: 40, passedOver: 10 },
    { date: '2026-08-03', gotcha: 0, team: 0, alone: 0, passedOver: 0 },
  ],
});

describe('★★ 06 — "Conversations a day": GOTCHA dark beneath your team, against the busiest day', () => {
  it('each day stacked, its height a share of the busiest (50 here)', async () => {
    render(await ConversationsADay({ daily: SERIES, fallbackDays: FALLBACK }));
    const day = (i: number) => screen.getByTestId(`conversations-a-day-day-${i}`);
    const [light, dark] = [...day(1).querySelectorAll<HTMLElement>('[style]')];
    expect(dark!.style.blockSize).toBe('86%');
    expect(light!.style.blockSize).toBe('14%');
    expect(day(0).querySelectorAll<HTMLElement>('[style]')[1]!.style.blockSize).toBe('50%');
    // A quiet day is an empty track, not a sliver.
    expect(day(2).querySelectorAll('[style]')).toHaveLength(0);
  });

  it('★ the series’ days are UTC dates, named as such — never shifted a day by the viewer’s zone', async () => {
    render(await ConversationsADay({ daily: SERIES, fallbackDays: FALLBACK }));
    // 2026-08-01 is a Saturday in UTC.
    expect(screen.getByTestId('conversations-a-day-day-0')).toHaveTextContent('Sat');
  });

  it('unread: seven empty columns on the axis, and the sentence — no zeros', async () => {
    render(await ConversationsADay({ daily: null, fallbackDays: FALLBACK }));
    const chart = screen.getByTestId('conversations-a-day');
    expect(chart.querySelectorAll('li')).toHaveLength(7);
    expect(chart.querySelectorAll('[style]')).toHaveLength(0);
    expect(chart).toHaveTextContent('The days couldn’t be read.');
  });
});

describe('★★ 06b — "Alone, or with a person", from the same series', () => {
  it('alone dark, passed over light', async () => {
    render(await AloneChart({ daily: SERIES, fallbackDays: FALLBACK }));
    const [light, dark] = [
      ...screen.getByTestId('gotcha-alone-day-1').querySelectorAll<HTMLElement>('[style]'),
    ];
    expect(dark!.style.blockSize).toBe('80%');
    expect(light!.style.blockSize).toBe('20%');
  });
});

describe('★ the contract refuses the other /daily', () => {
  it('the Redis volumes route answers an array — not a series', () => {
    expect(
      dailySeriesSchema.safeParse([{ date: '2026-08-01', total: 3, inbound: 1, outbound: 2 }])
        .success,
    ).toBe(false);
  });
});
