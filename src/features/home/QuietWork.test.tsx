import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { QuietDayItem } from '@/api/contracts/analytics';
import en from '@/i18n/messages/en/home.json';
import he from '@/i18n/messages/he/home.json';

let messages: typeof en = en;
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'home.quietWork') =>
    createTranslator({ locale: 'en', messages: { home: messages }, namespace }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('./ConflictRow', () => ({ ConflictRow: () => null }));

import { QUIET_SOURCES, quietRows } from './quiet-day-item';
import { QuietWork } from './QuietWork';

const ITEMS: QuietDayItem[] = [
  {
    id: 'a',
    source: 'unanswered_question',
    effect: 'removes_work',
    basis: {},
    kind: 'knowledge_gap.no_knowledge',
    values: { question: 'Dispatch cut-off?', askCount: 20, askedBy: 18 },
    rank: 1,
  },
  {
    id: 'b',
    source: 'unanswered_question',
    effect: 'removes_work',
    basis: {},
    kind: 'knowledge_gap.low_confidence',
    values: { question: 'Gift wrap?', askCount: 13, askedBy: 12 },
    rank: 2,
  },
  {
    id: 'c',
    source: 'product_demand',
    effect: 'removes_work',
    basis: {},
    kind: 'product_demand.not_stocked',
    values: { term: 'navy towels', askCount: 22, askedBy: 22, weeksRunning: 2 },
    rank: 3,
  },
  {
    id: 'd',
    source: 'dormant_customers',
    effect: 'creates_opportunity',
    basis: {},
    kind: 'dormant_customers.reachable',
    values: { count: 640, quietForDays: 90 },
    rank: 4,
  },
];

const card = async (items = ITEMS) =>
  render(await QuietWork({ quietDay: { sources: {}, data: items }, conflicts: [] }));

describe('★★ 01b — the card, as 02 draws it', () => {
  it('one row per source; the questions in one row, with "Answer them"', async () => {
    await card();
    const gaps = screen.getByTestId('quiet-row-unanswered_question');
    expect(gaps).toHaveTextContent('2 questions it could not answer');
    expect(gaps).toHaveTextContent('“Dispatch cut-off?”, “Gift wrap?” — asked 33 times');
    expect(gaps).toHaveTextContent('Answer them');
    expect(screen.getByTestId('quiet-row-product_demand')).toHaveTextContent(
      '22 people asked for navy towels',
    );
  });

  it('only the first row’s action is the dark one', async () => {
    await card();
    const links = screen.getAllByRole('link');
    expect(links[0]).toHaveTextContent('Answer them');
    expect(links[0]!.className).toMatch(/actionPrimary/);
    for (const other of links.slice(1)) expect(other.className).toMatch(/actionSecondary/);
  });

  it.each([
    ['en', en],
    ['he', he],
  ] as const)('★ every source the ranker reports has its copy (%s)', (_, catalogue) => {
    const item = catalogue.quietWork.item as Record<string, Record<string, string>>;
    const keys = new Set(
      quietRows(
        QUIET_SOURCES.flatMap(
          (source) =>
            [
              {
                id: `${source}1`,
                source,
                effect: 'removes_work',
                basis: {},
                kind: `${source}.x`,
                rank: 1,
                values: {
                  question: 'Q',
                  askCount: 2,
                  askedBy: 1,
                  term: 't',
                  weeksRunning: 1,
                  field: 'f',
                  count: 3,
                  quietForDays: 30,
                },
              },
              {
                id: `${source}2`,
                source,
                effect: 'removes_work',
                basis: {},
                kind: `${source}.x`,
                rank: 2,
                values: {
                  question: 'R',
                  askCount: 2,
                  askedBy: 1,
                  term: 'u',
                  weeksRunning: 1,
                  field: 'g',
                  count: 3,
                  quietForDays: 30,
                },
              },
            ] as QuietDayItem[],
        ),
      ).map((r) => r.key),
    );
    keys.add('demandOne');
    for (const key of keys) {
      expect(item[key]?.title, key).toBeTruthy();
      expect(item[key]?.body, key).toBeTruthy();
      expect(item[key]?.action, key).toBeTruthy();
    }
  });

  it('Hebrew renders every row with text', async () => {
    messages = he as never;
    await card();
    for (const row of screen.getAllByTestId(/^quiet-row-/)) {
      expect(row.querySelector('p')?.textContent?.trim()).not.toBe('');
    }
    messages = en;
  });
});
