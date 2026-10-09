import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { productDemandSchema } from '@/api/contracts/analytics';
import analytics from '@/i18n/messages/en/analytics.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'analytics') =>
    createTranslator({ locale: 'en', messages: { analytics }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
}));

import {
  AskedNotGot,
  MoneySources,
  SalesHero,
  SalesStrip,
  termWords,
  WhatYouLost,
} from './SalesTab';

const demand = productDemandSchema.parse({
  weekKey: '2026-W40',
  data: [
    {
      id: 'd1',
      term: 'navy towels',
      askCount: 11,
      askedBy: 11,
      inCatalogue: false,
      weeksRunning: 3,
    },
    {
      id: 'd2',
      term: 'gift wrapping',
      askCount: 9,
      askedBy: 9,
      inCatalogue: false,
      weeksRunning: 1,
    },
    { id: 'd3', term: 'sand linen', askCount: 4, askedBy: 4, inCatalogue: true, weeksRunning: 1 },
  ],
});

describe('★★ 06d - nothing ties a sale to a conversation, and it says so', () => {
  it('★ the dark card: no revenue figure, the reason', async () => {
    render(await SalesHero());
    const hero = screen.getByTestId('sales-hero');
    expect(hero).toHaveTextContent("What conversations sold isn't known yet.");
    expect(hero).not.toHaveTextContent(/₪|\$|\d/);
  });

  it('the strip: all five drawn, every one "-", never 0', async () => {
    render(await SalesStrip());
    for (const key of ['revenue', 'wanted', 'bought', 'average', 'carts']) {
      expect(screen.getByTestId(`sales-${key}`)).toHaveTextContent('-');
    }
    expect(screen.getByTestId('sales-strip')).not.toHaveTextContent(/\b0\b/);
  });

  it('where the money came from keeps its place, said why', async () => {
    render(await MoneySources());
    expect(screen.getByTestId('sales-sources')).toHaveTextContent('Nothing ties a sale');
  });
});

describe('★★ what IS recorded: this week’s catalogue misses - as asks, never people', () => {
  it('★ what you lost: asks and how many things, from the misses only', async () => {
    render(await WhatYouLost({ demand }));
    expect(screen.getByTestId('sales-lost')).toHaveTextContent(
      "20 asks this week for 2 things you don't stock.",
    );
    expect(screen.getByTestId('sales-lost')).not.toHaveTextContent(/people/i);
  });

  it('⚠ a failed read is "-"; no misses says so', async () => {
    const { unmount } = render(await WhatYouLost({ demand: null }));
    expect(screen.getByTestId('sales-lost')).toHaveTextContent('-');
    unmount();
    render(await WhatYouLost({ demand: productDemandSchema.parse({ data: [] }) }));
    expect(screen.getByTestId('sales-lost')).toHaveTextContent(
      "Nobody asked for anything you don't stock",
    );
  });

  it('★ the list: misses only, the term in words, asks, how many weeks running; no price', async () => {
    render(await AskedNotGot({ demand }));
    const rows = [...screen.getByTestId('sales-asked').querySelectorAll('li')];
    expect(rows.map((li) => li.getAttribute('data-testid'))).toEqual(['asked-d1', 'asked-d2']);
    expect(screen.getByTestId('asked-d1')).toHaveTextContent('Navy towels');
    expect(screen.getByTestId('asked-d1')).toHaveTextContent('asked 3 weeks running');
    expect(screen.getByTestId('asked-d1')).toHaveTextContent('11 asks');
    expect(screen.getByTestId('asked-d2')).toHaveTextContent('not stocked');
    expect(screen.getByTestId('asked-d1')).toHaveTextContent('-');
    expect(screen.getByTestId('sales-asked-foot')).toHaveTextContent(
      "Navy towels was searched for 11 times this week and isn't in your catalogue.",
    );
  });

  it('⚠ a failed read is not "nothing went unfound"', async () => {
    const { unmount } = render(await AskedNotGot({ demand: null }));
    expect(screen.getByTestId('sales-asked-unavailable')).toBeInTheDocument();
    unmount();
    render(await AskedNotGot({ demand: productDemandSchema.parse({ data: [] }) }));
    expect(screen.getByTestId('sales-asked-none')).toBeInTheDocument();
  });

  it('termWords capitalises a lowercased term', () => {
    expect(termWords('navy towels')).toBe('Navy towels');
    expect(termWords('')).toBe('');
  });
});
